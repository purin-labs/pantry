import { HUMAN_CELL_TRANSFER } from "@purin-labs/production-simulation/recipes/bakery/human-cell-transfer";
import { sameScenarioCopy } from "./workspace-commands.ts";
import { sameDefinition } from "./production-scenario-api.ts";
import { acceptedProductionResults } from "./production-draft.ts";
import { summarizeRun } from "@purin-labs/production-simulation/simulator/run-comparison";
import type { BakeryRunComparison } from "@purin-labs/bakery-model/bakery-surface";
import { NO_FAULTS } from "@purin-labs/production-simulation/recipes/bakery/run-faults";
import { playbackAvailable } from "./playback-actions.ts";
import { canPrepareWorkcell } from "./workcell-preparation.ts";
import { rackOffset, type RackLayoutReview } from "./rack-layout.ts";
import type {
  BakeryRunSaveInspection,
  BakeryScenarioSaveInspection,
  BakerySurfaceRackLayout,
  BakerySurfaceTrayLayout,
} from "@purin-labs/bakery-model/bakery-surface";
import {
  layoutTray,
  pendingOperationContext,
  pendingSimulation,
  selectedTray,
  stepLabel,
} from "./scheduled-rehearsal.ts";
import type {
  PlannedProductionWorkcell,
  ProductionWorkcell,
  ProductionWorkcells,
} from "@purin-labs/production-simulation/recipes/bakery/production-workcells";
import type {
  ProductionReady,
  ProductionSession,
} from "./production-session.ts";
import { productionDraftSource } from "./production-draft.ts";
import type {
  ProductionAssignment,
  ProductionManualTask,
} from "@purin-labs/bakery-model/bakery-production-scenario";
import {
  type CellId,
  resourceInstance,
} from "@purin-labs/production-simulation/recipes/bakery/workcell-instances";
import type {
  RejectedBakerySurfaceCommandResultV1,
  BakerySurfaceCommandV1,
  BakerySurfaceContextV1,
  BakerySurfaceDraftReference,
  BakerySurfaceShiftLayout,
  BakerySurfaceRunSaveManifest,
  BakerySurfaceToolCommandName,
  BakerySurfaceRunPreview,
  BakerySurfaceRehearsalTray,
  BakerySurfaceManualTask,
  BakerySurfaceProductionAssignment,
  BakerySurfaceProductionDraft,
  BakerySurfaceScheduledRehearsal,
  BakerySurfacePlayback,
  BakerySurfaceSelection,
  BakeryDoorInspection,
  BakerySurfaceSummary,
  BakerySurfaceTaskDetail,
  BakeryRecordingAcceptanceReference,
} from "@purin-labs/bakery-model/bakery-surface";
import { currentRecordingAcceptanceReference } from "./recording-acceptance.ts";
import type {
  PhysicsReplay,
  PhysicsRequest,
} from "@purin-labs/bakery-model/bakery-physics";
import {
  physicsResources,
  physicsTasks,
} from "@purin-labs/production-simulation/recipes/bakery/physics-playback";
import {
  recordingHasDoor,
  type RecordingDocument,
} from "@purin-labs/production-simulation/simulator/playback-state";
import { fields, type Settings } from "@purin-labs/bakery-model/bakery";
import {
  metrics,
  type Run,
  type BakeryTask,
} from "@purin-labs/production-simulation/recipes/bakery/schedule";
import {
  activeRun,
  canReplaceProduction,
  simulatorShellView,
  type SimulatorState,
  type WorkspaceRunSaveStatus,
} from "./simulator-state.ts";
import {
  selectionContext,
  type Selection,
} from "@purin-labs/production-simulation/simulator/selection";
import {
  verifyStoredWorkspaceRun,
  type PreparedWorkspaceRun,
} from "./workspace-runs-api.ts";
import { workspaceRunReviewSummary } from "./workspace-run-review.ts";
import { canOpenWorkspaceRun, shiftProcedure } from "./simulator-state.ts";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever, sha256Hex } from "@purin-labs/std";
import type {
  BakeryWorkspaceRead,
  ProductionDraftView,
  ScheduledSession,
  SurfaceDigest,
} from "./bakery-surface-command-types.ts";

export async function bakerySurfaceContext(
  state: SimulatorState,
): Promise<BakerySurfaceContextV1> {
  const draft = await bakerySurfaceDraftReference(state);
  const candidate = await currentRecordingAcceptanceReference(state);
  const production = await productionDraftContext(state);
  return {
    schemaVersion: 1,
    kind: "bakery-workspace",
    surfaceSessionId: state.workspace.surfaceSessionId,
    surfaceEpoch: state.workspace.surfaceEpoch,
    capturedAt: Date.now(),
    comparison: await productionComparison(state),
    simulation: runningSimulation(state),
    runOpenReview:
      state.workspace.kind === "production" &&
      state.workspace.production.pending.kind === "run"
        ? workspaceRunReviewSummary(state.workspace.production.pending.review)
        : null,
    supportedCommands: supportedSurfaceCommands(state, candidate),
    active: activeBakerySurface(state, draft, candidate, production),
  };
}

function runningSimulation(state: SimulatorState) {
  const job = state.browserJob;
  return job.kind === "loading" || job.kind === "running"
    ? { generation: job.generation, operationId: job.operationId }
    : null;
}

export function simulationMatches(
  state: SimulatorState,
  command: Variant<BakerySurfaceCommandV1, "stop_simulation">,
): boolean {
  const job = runningSimulation(state);
  return (
    job !== null &&
    job.generation === command.simulation.generation &&
    job.operationId === command.simulation.operationId
  );
}

function supportedSurfaceCommands(
  state: SimulatorState,
  candidate: BakeryRecordingAcceptanceReference | null,
): readonly BakerySurfaceToolCommandName[] {
  if (state.workspace.kind === "shift") {
    const commands: BakerySurfaceToolCommandName[] = [
      "inspect_surface",
      "inspect_scenario_save",
      "read_draft",
      "query_tasks",
      "set_view",
      "control_workspace_view",
      "prepare_edit",
    ];
    if (state.procedureLoad.kind !== "loading") commands.push("run_shift");
    commands.push("select_item", "compare_shift");
    if (state.procedureLoad.kind !== "loading")
      commands.push("start_production");
    if (shiftFloorPlan !== null)
      commands.push(
        "rotate_equipment",
        "set_equipment_angle",
        "move_equipment",
        "toggle_opening",
        "select_floor_plan",
        "configure_interior",
        "reset_floor_plan",
      );
    if (playbackAvailable(state)) commands.push("control_playback");
    if (canPrepareWorkcell(state)) commands.push("prepare_workcell");
    if (
      state.run.shift.kind === "procedure" &&
      state.scenario.assumptionDraft.size === 0 &&
      state.procedureLoad.kind !== "loading" &&
      state.workspace.scenarioSaveProposal.kind === "none"
    )
      commands.push("prepare_scenario_save");
    return commands;
  }
  const commands: BakerySurfaceToolCommandName[] = [
    "inspect_surface",
    "inspect_scenario_save",
  ];
  if (
    canOpenWorkspaceRun(state) &&
    state.workspace.production.pending.kind === "none"
  )
    commands.push("prepare_run_open");
  if (state.workspace.kind === "production")
    commands.push("list_saved_runs", "inspect_run_save", "file_action");
  if (state.workspace.kind === "rehearsal" && state.replay.kind === "recording")
    commands.push("set_view");
  if (
    state.workspace.kind === "production" &&
    state.workspace.production.data.kind === "ready"
  )
    commands.push("show_production_panel");
  if (comparisonSource(state) !== null) commands.push("control_baseline");
  if (canPrepareWorkcell(state)) commands.push("prepare_workcell");
  if (playbackAvailable(state)) commands.push("control_playback");
  if (
    state.workspace.kind === "production" &&
    state.workspace.production.procedure === "rehearsal"
  ) {
    const session = state.workspace.production;
    const idle =
      !session.reading &&
      session.rehearsalReview === null &&
      state.browserJob.kind !== "loading" &&
      state.browserJob.kind !== "running";
    if (session.data.kind === "ready" && session.readOnly.length === 0) {
      const plan = session.data.plan;
      commands.push("set_view");
      if (
        idle &&
        session.pending.kind === "none" &&
        pendingSimulation(plan, session.data.run) !== null
      )
        commands.push("simulate_workcell");
      if (idle && layoutTray(plan, selectedTray(session)) !== null)
        commands.push("prepare_layout");
      if (rehearsalEditable(state, session)) commands.push("edit_rehearsal");
    }
    const status = state.workspace.runSaves.rehearsal;
    if (
      rehearsalSaveSource(state) !== null &&
      status.kind !== "saving" &&
      status.kind !== "outcome-unknown" &&
      status.kind !== "saved-readback-failed"
    )
      commands.push("prepare_run_save");
  }
  if (
    state.workspace.kind === "production" &&
    state.workspace.production.procedure === "financier"
  ) {
    const session = state.workspace.production;
    const procedure = session.sourceProcedure ?? shiftProcedure(state);
    if (
      session.identity.kind === "new" &&
      session.preview !== null &&
      procedure !== null &&
      sameSettings(procedure.settings, session.preview.plan.settings) &&
      !session.savingDefinition &&
      !session.openingDefinition &&
      state.workspace.scenarioSaveProposal.kind === "none"
    )
      commands.push("prepare_scenario_save");
    if (session.data.kind === "ready") {
      commands.push("set_view");
      if (
        !session.reading &&
        session.pending.kind === "none" &&
        session.replacement === null &&
        session.rehearsalReview === null &&
        session.readOnly.length === 0 &&
        state.browserJob.kind !== "loading" &&
        state.browserJob.kind !== "running" &&
        pendingSimulation(session.data.plan, session.data.run) !== null
      )
        commands.push("simulate_workcell");
    }
    if (authorableProduction(state) !== null)
      commands.push("edit_production", "preview_production");
    if (applicablePreview(state) !== null || reviewablePreview(state) !== null)
      commands.push("apply_production");
  }
  if (candidate !== null) commands.push("accept_candidate");
  if (candidate?.kind === "production") commands.push("discard_candidate");
  commands.push("control_workspace_view");
  if (runningSimulation(state) !== null) commands.push("stop_simulation");
  return commands;
}

// Only a rehearsal on the production scheduler is saved.
export function rehearsalSaveSource(
  state: SimulatorState,
): ProductionWorkcells | null {
  return scheduledSession(state)?.data.plan ?? null;
}

export function sameSettings(left: Settings, right: Settings): boolean {
  for (const field of fields)
    if (left[field.key] !== right[field.key]) return false;
  return true;
}

export function runSaveManifest(
  prepared: PreparedWorkspaceRun,
): BakerySurfaceRunSaveManifest {
  if (prepared.snapshot.kind !== "rehearsal")
    throw new Error("A rehearsal save requires a rehearsal snapshot.");
  return {
    kind: "rehearsal",
    id: prepared.id,
    name: prepared.snapshot.name,
    bytes: prepared.bytes,
  };
}

function activeBakerySurface(
  state: SimulatorState,
  draft: BakerySurfaceDraftReference,
  candidate: Awaited<ReturnType<typeof currentRecordingAcceptanceReference>>,
  production: BakerySurfaceProductionDraft | null,
): BakerySurfaceContextV1["active"] {
  switch (state.workspace.kind) {
    case "shift":
      return shiftSurface(state, draft);
    case "rehearsal":
      return recordingSurface(state);
    case "production":
      return state.workspace.production.procedure === "rehearsal"
        ? scheduledRehearsalSurface(
            state,
            candidate?.kind === "production" ? candidate : null,
          )
        : productionSurface(
            state,
            candidate?.kind === "production" ? candidate : null,
            production,
          );
  }
}

// A rehearsal on the production scheduler: its awaited step, its tray steps
// and the tray a rack translation may move.
function scheduledRehearsalSurface(
  state: SimulatorState,
  candidate: Variant<BakeryRecordingAcceptanceReference, "production"> | null,
): BakerySurfaceScheduledRehearsal {
  const session = state.workspace.production;
  const playback: BakerySurfacePlayback = {
    cursorSeconds: session.cursor.time,
    playback: session.cursor.playback,
    speed: 120,
  };
  if (session.data.kind !== "ready")
    return {
      kind: "rehearsal",
      view: {
        camera: state.view.camera === "overhead" ? "overhead" : "perspective",
      },
      rehearsalKind: "scheduled",
      panel: session.panel,
      rackLayout: null,
      readiness: "empty",
      selection: null,
      playback,
      runId: null,
      attemptId: null,
      planFingerprint: null,
      pendingOperation: null,
      tasks: [],
      resources: [],
      trays: [],
      bakerCount: 0,
      faults: NO_FAULTS,
      editReview: null,
      candidate: null,
      runSaveProposal: currentRunSaveProposal(state),
    };
  const plan = session.data.plan;
  const run = session.data.run;
  const resources: BakerySurfaceSummary[] = [];
  for (const cell of run.workcells) {
    const reservation = run.nativeReservations.find(
      activeReservation.bind(null, cell.id, session.cursor.time),
    );
    resources.push({
      id: cell.id,
      label: resourceInstance(cell.id).name,
      state:
        reservation === undefined
          ? "available"
          : `held by ${reservation.operationId}`,
    });
  }
  for (const reservation of run.nativeReservations) {
    if (!reservation.resources.includes(HUMAN_CELL_TRANSFER.buffer)) continue;
    const time = session.cursor.time;
    if (
      time < reservation.start ||
      (reservation.kind === "released" && time >= reservation.end)
    )
      continue;
    resources.push({
      id: HUMAN_CELL_TRANSFER.buffer,
      label: "Human transfer buffer · capacity 1 (assumed)",
      state: `${reservation.kind} for ${reservation.materialId}${reservation.kind === "held" ? "; location uncertain" : ""}`,
    });
  }
  for (const resource of run.resources)
    resources.push({
      id: resource.id,
      label: resource.name,
      state: `${plan.operations.filter(stagedBy.bind(null, resource.id)).length} trays`,
    });
  return {
    kind: "rehearsal",
    view: {
      camera: state.view.camera === "overhead" ? "overhead" : "perspective",
    },
    rehearsalKind: "scheduled",
    panel: session.panel,
    rackLayout: trayLayoutContext(session),
    readiness: "ready",
    selection: productionSelection(session),
    playback,
    runId: null,
    attemptId: null,
    planFingerprint: plan.fingerprint,
    pendingOperation:
      session.pending.kind === "none" && session.readOnly.length === 0
        ? pendingOperationContext(plan, session.data.run)
        : null,
    tasks: [...plan.operations, ...plan.planned]
      .sort(byTrayStep)
      .map(stepSummary),
    resources,
    trays: plan.operations.filter(isTrayRoot).map(trayContext),
    bakerCount: plan.settings.workerCount,
    faults: plan.faults,
    editReview: session.rehearsalReview?.summary ?? null,
    candidate,
    runSaveProposal: currentRunSaveProposal(state),
  };
}

function isTrayRoot(operation: ProductionWorkcell): boolean {
  return operation.step === 1;
}

function trayContext(root: ProductionWorkcell): BakerySurfaceRehearsalTray {
  return {
    batchId: root.batchId,
    ingredients: root.attempt.input.request.ingredients,
    cellId: root.attempt.input.bindings.cell,
    baker: Number(root.workerId.slice("human-".length)),
    dependsOn: root.dependsOn,
    earliestStartSeconds: root.earliestStartSeconds,
  };
}

export function scheduledSession(state: SimulatorState): ScheduledSession | null {
  if (state.workspace.kind !== "production") return null;
  const session = state.workspace.production;
  if (
    session.procedure !== "rehearsal" ||
    session.data.kind !== "ready" ||
    session.readOnly.length > 0
  )
    return null;
  return { ...session, data: session.data };
}

// A tray edit rebuilds the plan, so it waits for a running job and for a
// result under review.
export function rehearsalEditable(
  state: SimulatorState,
  session: ProductionSession,
): boolean {
  return (
    !session.reading &&
    session.rehearsalReview === null &&
    session.pending.kind === "none" &&
    state.browserJob.kind !== "loading" &&
    state.browserJob.kind !== "running"
  );
}

// A financier draft chat may edit or preview: no read, open or save runs.
export function authorableProduction(state: SimulatorState): ProductionSession | null {
  if (state.workspace.kind !== "production") return null;
  const session = state.workspace.production;
  return productionDraftSource(session) !== null &&
    !session.reading &&
    !session.openingDefinition &&
    !session.savingDefinition &&
    session.replacement === null
    ? session
    : null;
}

// Applying a preview replaces the run and its native requests, so chat
// applies one only while the run holds no result, accepted or under review,
// and no browser job runs.
export function applicablePreview(state: SimulatorState): ProductionReady | null {
  const session = authorableProduction(state);
  if (
    session === null ||
    session.data.kind !== "ready" ||
    session.preview === null ||
    session.preview.plan.fingerprint === session.data.plan.fingerprint ||
    session.pending.kind !== "none" ||
    !session.data.plan.operations.every(awaitingEvidence) ||
    state.browserJob.kind === "loading" ||
    state.browserJob.kind === "running"
  )
    return null;
  return session.preview;
}

// A preview that would replace accepted results; the operator reviews it.
export function reviewablePreview(state: SimulatorState): ProductionReady | null {
  const session = authorableProduction(state);
  if (
    session === null ||
    session.data.kind !== "ready" ||
    session.preview === null ||
    session.preview.plan.fingerprint === session.data.plan.fingerprint ||
    acceptedProductionResults(session.data.plan) === 0 ||
    !canReplaceProduction(state)
  )
    return null;
  return session.preview;
}

function awaitingEvidence(operation: ProductionWorkcell): boolean {
  return operation.attempt.kind === "awaiting-evidence";
}

function productionDraftView(
  session: ProductionSession,
): ProductionDraftView | null {
  const source = productionDraftSource(session);
  if (source === null) return null;
  const preview = session.preview;
  return {
    replacement: session.replacement?.summary ?? null,
    batchCount: source.settings.batchCount,
    traysPerBatch: source.settings.traysPerBatch,
    bakerCount: source.settings.workerCount,
    variant: source.variant,
    assignments: source.draft.map(assignmentContext),
    manualTasks: source.manualTasks.map(manualTaskContext),
    preview:
      preview === null
        ? null
        : {
            planFingerprint: preview.plan.fingerprint,
            operationCount: preview.plan.operations.length,
            run: runPreview(preview.run),
          },
  };
}

// What a production command binds: the draft chat sees, in its copy.
export function productionDraftMaterial(session: ProductionSession): string | null {
  const view = productionDraftView(session);
  const identity = session.identity;
  return view === null
    ? null
    : JSON.stringify({
        identity: {
          kind: identity.kind,
          id: identity.kind === "saved" ? identity.definition.id : identity.id,
        },
        ...view,
      });
}

async function productionDraftContext(
  state: SimulatorState,
): Promise<BakerySurfaceProductionDraft | null> {
  if (state.workspace.kind !== "production") return null;
  const session = state.workspace.production;
  const view = productionDraftView(session);
  const material = productionDraftMaterial(session);
  return view === null || material === null
    ? null
    : { digest: await sha256Hex(material), ...view };
}

function assignmentContext(
  assignment: ProductionAssignment,
): BakerySurfaceProductionAssignment {
  return {
    batchId: assignment.batchId,
    tray: assignment.tray,
    baker: bakerNumber(assignment.workerId),
    dependsOn: assignment.dependsOn,
    earliestStartSeconds: assignment.earliestStartSeconds,
  };
}

function manualTaskContext(
  task: ProductionManualTask,
): BakerySurfaceManualTask {
  return {
    bakeryTaskId: task.bakeryTaskId,
    baker: task.workerId === null ? null : bakerNumber(task.workerId),
    dependsOn: task.dependsOn,
    earliestStartSeconds: task.earliestStartSeconds,
  };
}

function bakerNumber(workerId: `human-${number}`): number {
  return Number(workerId.slice("human-".length));
}

function trayLayoutContext(
  session: ProductionSession,
): BakerySurfaceTrayLayout | null {
  if (session.data.kind !== "ready") return null;
  const tray = layoutTray(session.data.plan, selectedTray(session));
  if (tray === null) return null;
  const review =
    session.layout?.operationId === tray.id
      ? session.layout.review
      : ({ kind: "none" } as const);
  return {
    operationId: tray.id,
    ...rackLayoutFor(tray.attempt.input.request, review),
  };
}

function stepSummary(
  operation: ProductionWorkcell | PlannedProductionWorkcell,
): BakerySurfaceSummary {
  return {
    id: operation.id,
    label: stepLabel(operation),
    state: operation.attempt === undefined ? "planned" : operation.attempt.kind,
  };
}
function byTrayStep(
  left: ProductionWorkcell | PlannedProductionWorkcell,
  right: ProductionWorkcell | PlannedProductionWorkcell,
): number {
  return left.batchId.localeCompare(right.batchId) || left.step - right.step;
}
function stagedBy(workerId: string, operation: ProductionWorkcell): boolean {
  return operation.step === 1 && operation.workerId === workerId;
}
function activeReservation(
  cellId: CellId,
  time: number,
  reservation: Run["nativeReservations"][number],
): boolean {
  return (
    reservation.resources.includes(cellId) &&
    reservation.start <= time &&
    (reservation.kind !== "released" || time < reservation.end)
  );
}
export function hasId(id: string, item: { readonly id: string }): boolean {
  return item.id === id;
}

function shiftSurface(
  state: SimulatorState,
  draft: BakerySurfaceDraftReference,
): Variant<BakerySurfaceContextV1["active"], "shift"> {
  const run = activeRun(state);
  const result = metrics(run);
  return {
    kind: "shift",
    source: state.run.shift.kind,
    sourceIdentity: shiftSourceIdentity(state),
    view: {
      dock: state.view.dock,
      camera: state.view.camera === "overhead" ? "overhead" : "perspective",
      labels: state.view.labels,
      minimap: state.view.minimap,
      chrome: state.view.chrome,
    },
    variant: state.run.variant,
    selection: scheduleSelection(state.view.selection),
    selectedTask: selectedShiftTask(state),
    playback: {
      cursorSeconds: simulatorShellView(state).playback.time,
      playback: simulatorShellView(state).playback.playback,
      speed: simulatorShellView(state).playback.speed,
    },
    draft,
    pendingEdit: state.scenario.surfaceEditProposal,
    scenarioSaveProposal:
      state.workspace.scenarioSaveProposal.kind !== "none" &&
      state.workspace.scenarioSaveProposal.payload.kind === "scenario"
        ? state.workspace.scenarioSaveProposal.manifest
        : null,
    run: {
      state: run.kind,
      endSeconds: run.end,
      lateBatches: result.late,
      unfinishedBatches: result.unfinished,
    },
    ...shiftLayoutField(),
  };
}

// The floor plan modules need a browser, so the route supplies the reader.
let shiftFloorPlan: (() => BakerySurfaceShiftLayout) | null = null;

export function provideShiftFloorPlan(
  read: () => BakerySurfaceShiftLayout,
): () => void {
  shiftFloorPlan = read;
  return releaseShiftFloorPlan.bind(null, read);
}

function releaseShiftFloorPlan(read: () => BakerySurfaceShiftLayout): void {
  if (shiftFloorPlan === read) shiftFloorPlan = null;
}

export function shiftLayout(): BakerySurfaceShiftLayout | null {
  return shiftFloorPlan?.() ?? null;
}

function shiftLayoutField(): Readonly<{ layout?: BakerySurfaceShiftLayout }> {
  const layout = shiftLayout();
  return layout === null ? {} : { layout };
}

export async function bakerySurfaceDraftReference(
  state: SimulatorState,
  digest: SurfaceDigest = sha256Hex,
): Promise<BakerySurfaceDraftReference> {
  return {
    revision: state.scenario.draftRevision,
    digest: await digest(bakerySurfaceDraftMaterial(state)),
  };
}

export function bakerySurfaceDraftMaterial(state: SimulatorState): string {
  const assumptions = [...state.scenario.assumptionDraft.entries()].sort(
    compareDraftEntries,
  );
  return JSON.stringify({
    source: state.run.shift.kind,
    settings: normalSettings(state),
    assumptions,
  });
}

export function normalSettings(
  state: SimulatorState,
): Readonly<Record<string, number>> {
  return activeRun({
    ...state,
    run: { ...state.run, variant: "normal" },
  }).settings;
}

function shiftSourceIdentity(
  state: SimulatorState,
): Variant<BakerySurfaceContextV1["active"], "shift">["sourceIdentity"] {
  if (state.run.shift.kind === "sample")
    return { kind: "sample", id: "financier-sample" };
  const source = state.run.shift.normal.source;
  return {
    kind: "procedure",
    id: source.reference.entityId,
    revision: source.revisionKey,
    snapshotRevision: String(source.snapshotRevision),
  };
}

function selectedShiftTask(
  state: SimulatorState,
): BakerySurfaceTaskDetail | null {
  const run = activeRun(state);
  const playback = simulatorShellView(state).playback.time;
  const selected = selectionContext(run, state.view.selection, playback).task;
  return selected === null ? null : shiftTaskDetail(run, selected, playback);
}

export function shiftTaskDetail(
  run: Run,
  task: BakeryTask,
  cursorSeconds: number,
): BakerySurfaceTaskDetail {
  const priorTasks: BakeryTask[] = [];
  for (const interval of run.intervals)
    if (
      interval.kind !== "wait" &&
      interval.batch === task.batch &&
      interval.id !== task.id &&
      interval.end <= task.start
    )
      priorTasks.push(interval);
  const dependencies = priorTasks
    .sort(latestTaskFirst)
    .slice(0, 4)
    .map(taskIdentifier)
    .reverse();
  const resources = [`station:${task.station}`];
  if (task.attended) resources.push(`worker:${task.executor}`);
  const station = run.stationResources.find(
    stationMatches.bind(null, task.station),
  );
  const batch = run.batches.find(batchMatches.bind(null, task.batch));
  const constraints = [
    ...(station === undefined
      ? []
      : [`${station.id} capacity ${station.capacity} ${station.unit}`]),
    ...(batch === undefined ? [] : [`batch deadline ${batch.deadline}s`]),
  ];
  return {
    id: task.id,
    name: shiftTaskName(task),
    kind: task.kind,
    status:
      cursorSeconds < task.start
        ? "pending"
        : cursorSeconds < task.end
          ? "running"
          : "complete",
    startSeconds: task.start,
    endSeconds: task.end,
    batchId: task.batch,
    dependencies,
    resources,
    constraints,
  };
}

function shiftTaskName(task: BakeryTask): string {
  switch (task.kind) {
    case "process":
      return `${task.operation} · Batch ${task.batch}`;
    case "transfer":
      return `${task.from} to ${task.station} · Batch ${task.batch}`;
    case "handoff":
      return `${task.phase} handoff · Batch ${task.batch}`;
    case "native":
      return `Native ${task.operation.id} · Batch ${task.batch}`;
  }
}

function latestTaskFirst(left: BakeryTask, right: BakeryTask): number {
  return right.end - left.end;
}

function taskIdentifier(task: BakeryTask): string {
  return task.id;
}

function stationMatches(
  station: string,
  candidate: { readonly id: string },
): boolean {
  return candidate.id === station;
}

function batchMatches(
  batch: string,
  candidate: { readonly id: string },
): boolean {
  return candidate.id === batch;
}

function compareDraftEntries(
  left: readonly [string, string],
  right: readonly [string, string],
): number {
  return left[0].localeCompare(right[0]);
}

export function runPreview(run: Run): BakerySurfaceRunPreview {
  const result = metrics(run);
  return {
    state: run.kind,
    endSeconds: run.end,
    lateBatches: result.late,
    unfinishedBatches: result.unfinished,
  };
}

// Recorded transfers and model resources are projections of this exact source.
// Navigation does not create an execution result or candidate.
function recordingSurface(
  state: SimulatorState,
): Variant<BakerySurfaceContextV1["active"], "rehearsal"> {
  const document = simulatorShellView(state).recording.document;
  return {
    kind: "rehearsal",
    view: {
      camera: state.view.camera,
      doorInspection: recordingDoorInspection(document),
    },
    rehearsalKind: "standalone",
    rackLayout: null,
    readiness: document.kind,
    selection: document.kind === "ready" ? recordingSelection(document) : null,
    playback:
      document.kind === "empty"
        ? { cursorSeconds: 0, playback: "paused", speed: 120 }
        : replayPlayback(document.replay),
    runId:
      document.kind === "ready"
        ? firstRecordingRequest(document.recording).runId
        : null,
    attemptId: null,
    tasks:
      document.kind === "ready"
        ? physicsTasks(document.recording).map(
            recordingTaskSummary.bind(null, document),
          )
        : [],
    resources:
      document.kind === "ready"
        ? physicsResources(document.recording).map(recordingResourceSummary)
        : [],
    candidate: null,
    runSaveProposal: currentRunSaveProposal(state),
  };
}

function recordingDoorInspection(
  document: RecordingDocument,
): BakeryDoorInspection {
  if (document.kind === "empty" || !recordingHasDoor(document.recording))
    return { kind: "unavailable" };
  if (document.doorPreviewDegrees === null) return { kind: "recorded" };
  return { kind: "preview", degrees: document.doorPreviewDegrees };
}

function recordingSelection(
  document: Variant<RecordingDocument, "ready">,
): BakerySurfaceSelection | null {
  const selection = document.selection;
  if (selection === null) return null;
  const item =
    selection.kind === "task"
      ? physicsTasks(document.recording).find(
          hasRecordingIdentity.bind(null, selection.id),
        )
      : physicsResources(document.recording).find(
          hasRecordingIdentity.bind(null, selection.id),
        );
  return item === undefined
    ? null
    : { kind: selection.kind, id: item.id, label: item.name };
}

function hasRecordingIdentity(
  id: string,
  value: Readonly<{ id: string }>,
): boolean {
  return value.id === id;
}

function recordingTaskSummary(
  document: Variant<RecordingDocument, "ready">,
  task: ReturnType<typeof physicsTasks>[number],
): BakerySurfaceSummary {
  const start =
    document.source.kind === "standalone"
      ? task.start
      : task.start + document.source.input.dispatch.time;
  const end = start + task.end - task.start;
  return {
    id: task.id,
    label: task.name,
    state: `${start.toFixed(2)}–${end.toFixed(2)} s · recorded ${task.recording.outcome.kind}`,
  };
}

function recordingResourceSummary(
  resource: ReturnType<typeof physicsResources>[number],
): BakerySurfaceSummary {
  return { id: resource.id, label: resource.name, state: "recorded model" };
}

function currentRunSaveProposal(
  state: SimulatorState,
): BakerySurfaceRunSaveManifest | null {
  const proposal = state.workspace.runSaveProposal;
  return proposal.kind === "prepared"
    ? runSaveManifest(proposal.prepared)
    : null;
}

function productionSurface(
  state: SimulatorState,
  candidate: Variant<BakeryRecordingAcceptanceReference, "production"> | null,
  draft: BakerySurfaceProductionDraft | null,
): Variant<BakerySurfaceContextV1["active"], "production"> {
  const session = state.workspace.production;
  const scenarioSaveProposal =
    state.workspace.scenarioSaveProposal.kind !== "none" &&
    state.workspace.scenarioSaveProposal.payload.kind === "production-scenario"
      ? state.workspace.scenarioSaveProposal.manifest
      : null;
  if (session.data.kind !== "ready")
    return {
      kind: "production",
      view: {
        camera: state.view.camera === "overhead" ? "overhead" : "perspective",
      },
      panel: session.panel,
      pendingOperation: null,
      readiness: session.data.kind,
      planFingerprint: null,
      variant: null,
      operationCount: 0,
      operations: [],
      selection: null,
      playback: null,
      candidate: null,
      scenarioSaveProposal,
      draft: null,
    };
  const plan = session.data.plan;
  return {
    kind: "production",
    view: {
      camera: state.view.camera === "overhead" ? "overhead" : "perspective",
    },
    panel: session.panel,
    pendingOperation: pendingOperationContext(plan, session.data.run),
    readiness: "ready",
    planFingerprint: plan.fingerprint,
    variant: plan.variant,
    operationCount: plan.operations.length,
    operations: plan.operations.map(productionOperationSummary),
    selection: productionSelection(session),
    playback: {
      cursorSeconds: session.cursor.time,
      playback: session.cursor.playback,
      speed: 120,
    },
    candidate,
    scenarioSaveProposal,
    draft,
  };
}

function productionSelection(
  session: ProductionSession,
): BakerySurfaceSelection {
  if (
    session.panel === "files" &&
    session.data.kind === "ready" &&
    session.operationId !== null
  ) {
    const operation = session.data.plan.operations.find(
      hasId.bind(null, session.operationId),
    );
    if (operation !== undefined)
      return {
        kind: "operation",
        id: operation.id,
        label:
          session.procedure === "rehearsal"
            ? stepLabel(operation)
            : productionOperationSummary(operation).label,
      };
  }
  return scheduleSelection(session.selection);
}

function scheduleSelection(selection: Selection): BakerySurfaceSelection {
  return {
    kind: selection.kind,
    id: selection.id,
    label: `${selection.kind} ${selection.id}`,
  };
}

function replayPlayback(input: {
  readonly time: number;
  readonly playback: "paused" | "playing";
  readonly speed: number;
}): BakerySurfacePlayback {
  return {
    cursorSeconds: input.time,
    playback: input.playback,
    speed: input.speed,
  };
}

function productionOperationSummary(operation: {
  readonly id: string;
  readonly batchId: string;
  readonly tray: number;
  readonly attempt: { readonly kind: string };
}): BakerySurfaceSummary {
  return {
    id: operation.id,
    label: `Batch ${operation.batchId}, tray ${operation.tray}`,
    state: operation.attempt.kind,
  };
}

function firstRecordingRequest(recording: PhysicsReplay): PhysicsRequest {
  switch (recording.kind) {
    case "bakery-physics-recording":
      return recording.request;
    case "bakery-physics-sequence":
    case "bakery-physics-rack-sequence":
      return recording.loading.request;
  }
}

export function shiftSelection(
  run: ReturnType<typeof activeRun>,
  selection: Variant<BakerySurfaceCommandV1, "set_view">["view"]["selection"],
): Selection | null {
  switch (selection.kind) {
    case "batch": {
      for (const batch of run.batches)
        if (batch.id === selection.id) return { kind: "batch", id: batch.id };
      return null;
    }
    case "station":
      return shiftStationSelection(selection.id);
    case "task": {
      for (const interval of run.intervals)
        if (interval.kind !== "wait" && interval.id === selection.id)
          return { kind: "task", id: interval.id };
      return null;
    }
    case "resource": {
      for (const resource of run.resources)
        if (resource.id === selection.id)
          return { kind: "resource", id: resource.id };
      return null;
    }
    case "operation":
      return null;
  }
}

function shiftStationSelection(id: string): Selection | null {
  switch (id) {
    case "stage":
    case "portion":
    case "bake":
    case "cool":
    case "pack":
      return { kind: "station", id };
    default:
      return null;
  }
}

export function rejectedCommand(
  command: BakerySurfaceCommandV1["kind"],
  code: RejectedBakerySurfaceCommandResultV1["code"],
  message: string,
): RejectedBakerySurfaceCommandResultV1 {
  return { kind: "rejected", command, code, message };
}

function rackLayoutFor(
  request: PhysicsRequest,
  review: RackLayoutReview,
): BakerySurfaceRackLayout {
  const [xMm, yMm] = rackOffset(request.layout);
  let proposal: BakerySurfaceRackLayout["proposal"] = null;
  if (review.kind === "prepared") {
    const [x, y] = rackOffset(review.proposal.layout);
    proposal = {
      baseModelHash: request.modelHash,
      xMm: x,
      yMm: y,
      status: review.proposal.kind,
    };
  }
  return {
    modelHash: request.modelHash,
    xMm,
    yMm,
    editable: true,
    checks:
      "Rack X/Y ±600 mm. Solid overlap blocks Apply. Reach, motion and stability need simulation. Room, access and service clearances unchecked.",
    proposal,
  };
}

export function comparisonSource(state: SimulatorState): Run | null {
  if (state.workspace.kind !== "production") return null;
  const session = state.workspace.production;
  if (session.reading || session.data.kind !== "ready") return null;
  return session.preview?.run ?? session.data.run;
}

export async function productionComparison(
  state: SimulatorState,
): Promise<BakeryRunComparison | null> {
  const run = comparisonSource(state);
  if (run === null || state.workspace.kind !== "production") return null;
  const session = state.workspace.production;
  if (session.data.kind !== "ready") return null;
  const current = summarizeRun(run);
  const baseline = session.baseline;
  const fingerprint = (session.preview?.plan ?? session.data.plan).fingerprint;
  const digest = await sha256Hex(
    JSON.stringify({ fingerprint, current, baseline }),
  );
  return { digest, current, baseline };
}

export async function inspectWorkspaceRunSave(
  workspace: BakeryWorkspaceRead,
  runKind: "rehearsal" | "production",
  status: WorkspaceRunSaveStatus,
): Promise<BakeryRunSaveInspection> {
  if (
    status.kind === "idle" ||
    status.organisationId !== workspace.organisationId
  )
    return { kind: "idle" };
  const origin: "operator" | "agent" =
    status.agentEffectId === null ? "operator" : "agent";
  const reference = {
    id:
      status.kind === "verified" || status.kind === "saved-readback-failed"
        ? status.snapshot.id
        : status.id,
    name:
      status.kind === "verified" || status.kind === "saved-readback-failed"
        ? status.snapshot.name
        : status.name,
    requestId: status.requestId,
    origin,
  };
  switch (status.kind) {
    case "saving":
    case "verified":
    case "readback-confirmed":
      return { kind: status.kind, reference };
    case "outcome-unknown":
    case "saved-readback-failed":
    case "not-found":
      try {
        const result = await verifyStoredWorkspaceRun(
          workspace.organisationId,
          runKind,
          reference.id,
          reference.name,
          workspace.read,
        );
        return {
          kind: status.kind,
          reference,
          readback: result.kind === "verified" ? "verified" : "missing",
        };
      } catch {
        return { kind: status.kind, reference, readback: "unavailable" };
      }
    default:
      return assertNever(status);
  }
}

export async function inspectScenarioSave(
  workspace: BakeryWorkspaceRead,
  proposal: SimulatorState["workspace"]["scenarioSaveProposal"],
): Promise<BakeryScenarioSaveInspection> {
  if (proposal.kind === "none") return { kind: "idle" };
  if (
    proposal.kind !== "outcome-unknown" &&
    proposal.kind !== "saved-readback-failed"
  )
    return { kind: proposal.kind, manifest: proposal.manifest };
  let verified = false;
  try {
    const payload = proposal.payload;
    if (payload.kind === "scenario") {
      const result = await workspace.readScenario(
        workspace.organisationId,
        payload.copy.id,
      );
      verified =
        result.kind === "ready" && sameScenarioCopy(result.copy, payload.copy);
    } else {
      const result = await workspace.readDefinition(
        workspace.organisationId,
        payload.copy.id,
      );
      verified =
        result.kind === "ready" &&
        sameDefinition(result.definition, payload.copy);
    }
  } catch {
    // A failed read cannot establish absence or authorize a new save.
  }
  return {
    kind: proposal.kind,
    manifest: proposal.manifest,
    readback: verified ? "verified" : "unavailable",
  };
}
