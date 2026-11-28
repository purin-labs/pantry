import { parseBakeryProductionSnapshotSurface } from "./bakery-persistent-surface.ts";
import { parseBakeryPersistentSurface } from "./bakery-persistent-surface.ts";
import { parseShiftLayout } from "./bakery-floor-plan.ts";
import { MAX_LABEL_LENGTH, identifier, label } from "./bakery-surface-text.ts";
import {
  doorDegrees,
  parseRecordingCameraView,
  parseShiftView,
  recordingCamera,
  type BakeryCameraView,
  type BakeryDoorInspection,
  type BakeryRecordingCameraView,
} from "./bakery-surface-view.ts";
import { parseIngredientLoad, type IngredientLoad } from "./bakery-physics.ts";
import { parseBakeryBrowserBinding } from "./bakery-context.ts";
import type { SettingsField } from "./bakery";
import {
  MAX_RUN_SNAPSHOT_BYTES,
  isRunSnapshotId,
  isRunSnapshotCursor,
  parseRunSnapshotPage,
} from "./bakery-run-snapshot.ts";
import { parseSimulationOutput } from "./bakery-simulation-output.ts";
import type { Variant } from "@purin-labs/type-utils";
import { parseSurfaceObservation } from "@purin-labs/control-api";
import { hasExactKeys, isNonNegativeInteger, isRecord } from "@purin-labs/std";
import type {
  BakeryFileManifest,
  BakeryProductionPanel,
  BakeryProductionReplacement,
  BakeryRecordingAcceptanceReference,
  BakeryRehearsalChange,
  BakeryRehearsalFaults,
  BakeryRehearsalReview,
  BakeryRunComparison,
  BakeryRunOpenReview,
  BakeryRunSaveInspection,
  BakeryRunSaveReference,
  BakeryRunSummary,
  BakeryScenarioSaveInspection,
  BakerySimulationMode,
  BakerySimulationReference,
  BakerySurfaceCommandName,
  BakerySurfaceCommandParseResult,
  BakerySurfaceCommandResultV1,
  BakerySurfaceCommandV1,
  BakerySurfaceContextV1,
  BakerySurfaceDraftReference,
  BakerySurfaceDraftSnapshot,
  BakerySurfaceEditOperation,
  BakerySurfaceEditProposalV1,
  BakerySurfaceEffectOutcomeV1,
  BakerySurfaceEffectParseResult,
  BakerySurfaceManualTask,
  BakerySurfaceParseResult,
  BakerySurfacePendingOperation,
  BakerySurfacePlayback,
  BakerySurfaceProductionAssignment,
  BakerySurfaceProductionDraft,
  BakerySurfaceProductionPreview,
  BakerySurfaceRackLayout,
  BakerySurfaceReceiptParseResult,
  BakerySurfaceReference,
  BakerySurfaceRehearsalTray,
  BakerySurfaceRunPreview,
  BakerySurfaceRunSaveManifest,
  BakerySurfaceScenarioSaveManifest,
  BakerySurfaceScheduledRehearsal,
  BakerySurfaceSelection,
  BakerySurfaceSelectionTarget,
  BakerySurfaceSummary,
  BakerySurfaceTaskDetail,
  BakerySurfaceToolCommandName,
  BakerySurfaceTrayLayout,
} from "./bakery-surface-types.ts";

export const MAX_CONTEXT_BYTES = 16 * 1024;
export const MAX_SUMMARIES = 16;
// A production draft stores at most 60 manual tasks; each links to tasks of
// at most six batches.
const MAX_MANUAL_TASKS = 60;
const MAX_TASK_LINKS = 160;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
export const ENCODER = new TextEncoder();
const SETTINGS_FIELDS = [
  "batchCount",
  "workerCount",
  "rackTrays",
  "ovenTrays",
  "traysPerBatch",
  "piecesPerTray",
  "loadWindow",
  "loadSeconds",
  "unloadSeconds",
  "stage",
  "portion",
  "bake",
  "cool",
  "demould",
  "finishCooling",
  "pack",
  "horizonMinutes",
  "outageStart",
  "outageEnd",
] as const satisfies readonly SettingsField[];

export function parseBakeryProductionPanel(
  raw: unknown,
): BakeryProductionPanel | null {
  switch (raw) {
    case "workflow":
    case "timeline":
    case "files":
    case "details":
    case "author":
      return raw;
    default:
      return null;
  }
}

export function parseBakerySurfaceAttachment(
  raw: unknown,
): BakerySurfaceParseResult {
  if (!isRecord(raw) || !hasExactKeys(raw, ["kind", "digest", "context"]))
    return invalid("The Kitchen context envelope is invalid.");
  if (
    raw.kind !== "bakery-surface-context" ||
    typeof raw.digest !== "string" ||
    !SHA256_PATTERN.test(raw.digest)
  )
    return invalid("The Kitchen context identity is invalid.");
  const context = parseContext(raw.context);
  if (context === null)
    return invalid("The Kitchen context payload is invalid.");
  if (ENCODER.encode(JSON.stringify(context)).byteLength > MAX_CONTEXT_BYTES)
    return invalid("The Kitchen context exceeds the 16 KiB limit.");
  return {
    kind: "valid",
    value: { kind: "bakery-surface-context", digest: raw.digest, context },
  };
}

function parseProductionReplacement(
  raw: unknown,
): BakeryProductionReplacement | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "source",
      "sourceFingerprint",
      "proposedFingerprint",
      "currentResults",
      "proposedOperations",
    ]) ||
    (raw.source !== "preview" &&
      raw.source !== "procedure" &&
      raw.source !== "one-batch") ||
    !identifier(raw.sourceFingerprint) ||
    !identifier(raw.proposedFingerprint) ||
    !isNonNegativeInteger(raw.currentResults) ||
    !isNonNegativeInteger(raw.proposedOperations)
  )
    return null;
  return {
    source: raw.source,
    sourceFingerprint: raw.sourceFingerprint,
    proposedFingerprint: raw.proposedFingerprint,
    currentResults: raw.currentResults,
    proposedOperations: raw.proposedOperations,
  };
}

export function parseManualTask(
  raw: Readonly<Record<string, unknown>>,
  edit: boolean,
): BakerySurfaceManualTask | null {
  const dependsOn = taskLinks(raw.dependsOn);
  const keys = ["bakeryTaskId", "baker", "dependsOn", "earliestStartSeconds"];
  if (
    !hasExactKeys(raw, edit ? ["kind", ...keys] : keys) ||
    !identifier(raw.bakeryTaskId) ||
    (raw.baker !== null && !baker(raw.baker)) ||
    dependsOn === null ||
    !wholeSeconds(raw.earliestStartSeconds)
  )
    return null;
  return {
    bakeryTaskId: raw.bakeryTaskId,
    baker: raw.baker,
    dependsOn,
    earliestStartSeconds: raw.earliestStartSeconds,
  };
}

// Production tasks a tray or manual task waits for, each named once.
export function taskLinks(raw: unknown): string[] | null {
  return Array.isArray(raw) &&
    raw.length <= MAX_TASK_LINKS &&
    raw.every(identifier) &&
    new Set(raw).size === raw.length
    ? [...raw]
    : null;
}

function parseProductionDraft(
  raw: unknown,
): BakerySurfaceProductionDraft | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "digest",
      "batchCount",
      "traysPerBatch",
      "bakerCount",
      "variant",
      "assignments",
      "manualTasks",
      "preview",
      "replacement",
    ]) ||
    typeof raw.digest !== "string" ||
    !SHA256_PATTERN.test(raw.digest) ||
    !smallCount(raw.batchCount) ||
    !smallCount(raw.traysPerBatch) ||
    !baker(raw.bakerCount) ||
    (raw.variant !== "normal" && raw.variant !== "outage") ||
    !Array.isArray(raw.assignments) ||
    raw.assignments.length > MAX_SUMMARIES ||
    !Array.isArray(raw.manualTasks) ||
    raw.manualTasks.length > MAX_MANUAL_TASKS
  )
    return null;
  const replacement =
    raw.replacement === null
      ? null
      : parseProductionReplacement(raw.replacement);
  if (raw.replacement !== null && replacement === null) return null;
  const assignments: BakerySurfaceProductionAssignment[] = [];
  for (const assignment of raw.assignments) {
    const dependsOn = isRecord(assignment)
      ? taskLinks(assignment.dependsOn)
      : null;
    if (
      !isRecord(assignment) ||
      !hasExactKeys(assignment, [
        "batchId",
        "tray",
        "baker",
        "dependsOn",
        "earliestStartSeconds",
      ]) ||
      !identifier(assignment.batchId) ||
      !smallCount(assignment.tray) ||
      !baker(assignment.baker) ||
      dependsOn === null ||
      !wholeSeconds(assignment.earliestStartSeconds)
    )
      return null;
    assignments.push({
      batchId: assignment.batchId,
      tray: assignment.tray,
      baker: assignment.baker,
      dependsOn,
      earliestStartSeconds: assignment.earliestStartSeconds,
    });
  }
  const manualTasks: BakerySurfaceManualTask[] = [];
  for (const task of raw.manualTasks) {
    const parsed = isRecord(task) ? parseManualTask(task, false) : null;
    if (parsed === null) return null;
    manualTasks.push(parsed);
  }
  let preview: BakerySurfaceProductionPreview | null = null;
  if (raw.preview !== null) {
    const run = isRecord(raw.preview) ? parseRunPreview(raw.preview.run) : null;
    if (
      !isRecord(raw.preview) ||
      !hasExactKeys(raw.preview, [
        "planFingerprint",
        "operationCount",
        "run",
      ]) ||
      !identifier(raw.preview.planFingerprint) ||
      !smallCount(raw.preview.operationCount) ||
      run === null
    )
      return null;
    preview = {
      planFingerprint: raw.preview.planFingerprint,
      operationCount: raw.preview.operationCount,
      run,
    };
  }
  return {
    digest: raw.digest,
    batchCount: raw.batchCount,
    traysPerBatch: raw.traysPerBatch,
    bakerCount: raw.bakerCount,
    variant: raw.variant,
    assignments,
    manualTasks,
    replacement,
    preview,
  };
}

export function parseRehearsalFaults(raw: unknown): BakeryRehearsalFaults | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ["outage", "failure", "recovery"]))
    return null;
  let outage: BakeryRehearsalFaults["outage"] = null;
  if (raw.outage !== null) {
    const value = raw.outage;
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ["resource", "start", "end"]) ||
      !identifier(value.resource) ||
      !wholeSeconds(value.start) ||
      !wholeSeconds(value.end) ||
      value.end <= value.start
    )
      return null;
    outage = {
      resource: value.resource,
      start: value.start,
      end: value.end,
    };
  }
  let failure: BakeryRehearsalFaults["failure"] = null;
  if (raw.failure !== null) {
    const value = raw.failure;
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ["bakeryTaskId", "afterSeconds"]) ||
      !identifier(value.bakeryTaskId) ||
      !wholeSeconds(value.afterSeconds) ||
      value.afterSeconds < 1 ||
      value.afterSeconds > 600
    )
      return null;
    failure = {
      bakeryTaskId: value.bakeryTaskId,
      afterSeconds: value.afterSeconds,
    };
  }
  let recovery: BakeryRehearsalFaults["recovery"] = null;
  if (raw.recovery !== null) {
    const value = raw.recovery;
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ["bakeryTaskId", "seconds"]) ||
      !identifier(value.bakeryTaskId) ||
      !wholeSeconds(value.seconds) ||
      value.seconds < 1 ||
      value.seconds > 3600
    )
      return null;
    recovery = { bakeryTaskId: value.bakeryTaskId, seconds: value.seconds };
  }
  return { outage, failure, recovery };
}

export function parseRehearsalChange(raw: unknown): BakeryRehearsalChange | null {
  if (!isRecord(raw)) return null;
  if (
    raw.kind === "set_ingredients" &&
    hasExactKeys(raw, ["kind", "batchId", "ingredients"]) &&
    identifier(raw.batchId)
  ) {
    try {
      return {
        kind: "set_ingredients",
        batchId: raw.batchId,
        ingredients: parseIngredientLoad(raw.ingredients),
      };
    } catch {
      return null;
    }
  }
  if (
    raw.kind === "set_cell" &&
    hasExactKeys(raw, ["kind", "batchId", "cellId"]) &&
    identifier(raw.batchId) &&
    (raw.cellId === "cold-cell-1" || raw.cellId === "cold-cell-2")
  )
    return { kind: "set_cell", batchId: raw.batchId, cellId: raw.cellId };
  if (
    raw.kind === "replace_preset" &&
    hasExactKeys(raw, ["kind", "preset"]) &&
    (raw.preset === "two-trays" ||
      raw.preset === "table-to-rack" ||
      raw.preset === "table-to-oven" ||
      raw.preset === "oven-cycle" ||
      raw.preset === "oven-table-rack")
  )
    return { kind: "replace_preset", preset: raw.preset };
  if (
    (raw.kind === "clear_results" ||
      raw.kind === "remove_tray" ||
      raw.kind === "add_human_transfer") &&
    hasExactKeys(raw, ["kind", "batchId"]) &&
    identifier(raw.batchId)
  )
    return { kind: raw.kind, batchId: raw.batchId };
  return null;
}

function parseRehearsalReview(raw: unknown): BakeryRehearsalReview | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "change",
      "sourceFingerprint",
      "proposedFingerprint",
      "currentResults",
      "proposedResults",
    ]) ||
    !identifier(raw.sourceFingerprint) ||
    !identifier(raw.proposedFingerprint) ||
    !isNonNegativeInteger(raw.currentResults) ||
    !isNonNegativeInteger(raw.proposedResults)
  )
    return null;
  const change = parseRehearsalChange(raw.change);
  return change === null
    ? null
    : {
        change,
        sourceFingerprint: raw.sourceFingerprint,
        proposedFingerprint: raw.proposedFingerprint,
        currentResults: raw.currentResults,
        proposedResults: raw.proposedResults,
      };
}

function parseRehearsalTrays(
  raw: unknown,
): BakerySurfaceRehearsalTray[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_SUMMARIES) return null;
  const trays: BakerySurfaceRehearsalTray[] = [];
  for (const tray of raw) {
    if (
      !isRecord(tray) ||
      !hasExactKeys(tray, [
        ...(Object.hasOwn(tray, "ingredients") ? ["ingredients"] : []),
        "batchId",
        "cellId",
        "baker",
        "dependsOn",
        "earliestStartSeconds",
      ]) ||
      !identifier(tray.batchId) ||
      (tray.cellId !== "cold-cell-1" && tray.cellId !== "cold-cell-2") ||
      !baker(tray.baker) ||
      !Array.isArray(tray.dependsOn) ||
      tray.dependsOn.length > MAX_SUMMARIES * 3 ||
      !tray.dependsOn.every(identifier) ||
      !wholeSeconds(tray.earliestStartSeconds)
    )
      return null;
    let load: { ingredients: IngredientLoad } | Record<string, never> = {};
    if (Object.hasOwn(tray, "ingredients")) {
      try {
        load = { ingredients: parseIngredientLoad(tray.ingredients) };
      } catch {
        return null;
      }
    }
    trays.push({
      ...load,
      batchId: tray.batchId,
      cellId: tray.cellId,
      baker: tray.baker,
      dependsOn: [...tray.dependsOn],
      earliestStartSeconds: tray.earliestStartSeconds,
    });
  }
  return trays;
}

export function baker(value: unknown): value is number {
  return smallCount(value);
}

// Trays, batches, bakers and operations each number from 1 to 16.
export function smallCount(value: unknown): value is number {
  return (
    Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 16
  );
}

export function wholeSeconds(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseRunSummary(raw: unknown): BakeryRunSummary | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "kind",
      "end",
      "completed",
      "unfinished",
      "failed",
      "waiting",
    ]) ||
    (raw.kind !== "complete" &&
      raw.kind !== "blocked" &&
      raw.kind !== "horizon") ||
    typeof raw.end !== "number" ||
    !Number.isFinite(raw.end) ||
    raw.end < 0 ||
    typeof raw.waiting !== "number" ||
    !Number.isFinite(raw.waiting) ||
    raw.waiting < 0 ||
    !isNonNegativeInteger(raw.completed) ||
    !isNonNegativeInteger(raw.unfinished) ||
    !isNonNegativeInteger(raw.failed)
  )
    return null;
  return {
    kind: raw.kind,
    end: raw.end,
    completed: raw.completed,
    unfinished: raw.unfinished,
    failed: raw.failed,
    waiting: raw.waiting,
  };
}

export function parseRunComparison(raw: unknown): BakeryRunComparison | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["digest", "current", "baseline"]) ||
    typeof raw.digest !== "string" ||
    !SHA256_PATTERN.test(raw.digest)
  )
    return null;
  const current = parseRunSummary(raw.current);
  const baseline = raw.baseline === null ? null : parseRunSummary(raw.baseline);
  if (current === null || (raw.baseline !== null && baseline === null))
    return null;
  return { digest: raw.digest, current, baseline };
}

export function parseSimulationReference(
  raw: unknown,
): BakerySimulationReference | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["generation", "operationId"]) ||
    !isNonNegativeInteger(raw.generation) ||
    !identifier(raw.operationId)
  )
    return null;
  return { generation: raw.generation, operationId: raw.operationId };
}

function parseRunOpenReview(raw: unknown): BakeryRunOpenReview | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "id",
      "name",
      "runKind",
      "sourceFingerprint",
      "proposedFingerprint",
      "currentResults",
      "proposedResults",
    ]) ||
    !isRunSnapshotId(raw.id) ||
    typeof raw.name !== "string" ||
    raw.name.trim().length === 0 ||
    raw.name.length > 80 ||
    (raw.runKind !== "rehearsal" && raw.runKind !== "production") ||
    typeof raw.sourceFingerprint !== "string" ||
    !SHA256_PATTERN.test(raw.sourceFingerprint) ||
    typeof raw.proposedFingerprint !== "string" ||
    !SHA256_PATTERN.test(raw.proposedFingerprint) ||
    !isNonNegativeInteger(raw.currentResults) ||
    !isNonNegativeInteger(raw.proposedResults)
  )
    return null;
  return {
    id: raw.id,
    name: raw.name,
    runKind: raw.runKind,
    sourceFingerprint: raw.sourceFingerprint,
    proposedFingerprint: raw.proposedFingerprint,
    currentResults: raw.currentResults,
    proposedResults: raw.proposedResults,
  };
}

export function parseContext(raw: unknown): BakerySurfaceContextV1 | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "schemaVersion",
      "kind",
      "surfaceSessionId",
      "surfaceEpoch",
      "capturedAt",
      "comparison",
      "simulation",
      "runOpenReview",
      "supportedCommands",
      "active",
    ]) ||
    raw.schemaVersion !== 1 ||
    raw.kind !== "bakery-workspace" ||
    !identifier(raw.surfaceSessionId) ||
    !isNonNegativeInteger(raw.surfaceEpoch) ||
    !isNonNegativeInteger(raw.capturedAt) ||
    !Array.isArray(raw.supportedCommands)
  )
    return null;
  const supportedCommands = parseCommands(raw.supportedCommands);
  const comparison =
    raw.comparison === null ? null : parseRunComparison(raw.comparison);
  if (raw.comparison !== null && comparison === null) return null;
  const simulation =
    raw.simulation === null ? null : parseSimulationReference(raw.simulation);
  if (raw.simulation !== null && simulation === null) return null;
  const active = parseActive(raw.active);
  if (supportedCommands === null || active === null) return null;
  const runOpenReview =
    raw.runOpenReview === null ? null : parseRunOpenReview(raw.runOpenReview);
  if (
    raw.runOpenReview !== null &&
    (runOpenReview === null ||
      (active.kind !== "production" &&
        !(
          active.kind === "rehearsal" && active.rehearsalKind === "scheduled"
        )) ||
      active.planFingerprint !== runOpenReview.sourceFingerprint ||
      active.kind !== runOpenReview.runKind)
  )
    return null;
  if (
    active.kind !== "shift" &&
    active.kind !== "persistent" &&
    active.kind !== "persistent-snapshot" &&
    active.candidate !== null &&
    (active.candidate.surfaceSessionId !== raw.surfaceSessionId ||
      active.candidate.surfaceEpoch !== raw.surfaceEpoch)
  )
    return null;
  return {
    schemaVersion: 1,
    kind: "bakery-workspace",
    surfaceSessionId: raw.surfaceSessionId,
    surfaceEpoch: raw.surfaceEpoch,
    capturedAt: raw.capturedAt,
    comparison,
    simulation,
    runOpenReview,
    supportedCommands,
    active,
  };
}

function parseCommands(
  raw: readonly unknown[],
): BakerySurfaceToolCommandName[] | null {
  if (raw.length > 32) return null;
  const commands: BakerySurfaceToolCommandName[] = [];
  for (const value of raw) {
    if (
      value !== "inspect_surface" &&
      value !== "read_draft" &&
      value !== "query_tasks" &&
      value !== "set_view" &&
      value !== "control_baseline" &&
      value !== "show_production_panel" &&
      value !== "control_workspace_view" &&
      value !== "control_playback" &&
      value !== "prepare_workcell" &&
      value !== "prepare_layout" &&
      value !== "prepare_production_control" &&
      value !== "prepare_edit" &&
      value !== "run_shift" &&
      value !== "select_item" &&
      value !== "rotate_equipment" &&
      value !== "set_equipment_angle" &&
      value !== "move_equipment" &&
      value !== "toggle_opening" &&
      value !== "select_floor_plan" &&
      value !== "configure_interior" &&
      value !== "reset_floor_plan" &&
      value !== "compare_shift" &&
      value !== "start_production" &&
      value !== "prepare_run_save" &&
      value !== "file_action" &&
      value !== "inspect_scenario_save" &&
      value !== "inspect_run_save" &&
      value !== "list_saved_runs" &&
      value !== "prepare_run_open" &&
      value !== "prepare_scenario_save" &&
      value !== "stop_simulation" &&
      value !== "simulate_workcell" &&
      value !== "accept_candidate" &&
      value !== "discard_candidate" &&
      value !== "edit_rehearsal" &&
      value !== "edit_production" &&
      value !== "preview_production" &&
      value !== "apply_production"
    )
      return null;
    if (commands.includes(value)) return null;
    commands.push(value);
  }
  return commands;
}

function parseActive(raw: unknown): BakerySurfaceContextV1["active"] | null {
  if (!isRecord(raw) || typeof raw.kind !== "string") return null;
  switch (raw.kind) {
    case "persistent":
      return parseBakeryPersistentSurface(raw);
    case "persistent-snapshot":
      return parseBakeryProductionSnapshotSurface(raw);
    case "shift":
      return parseShift(raw);
    case "rehearsal":
      return parseRehearsal(raw);
    case "production":
      return parseProduction(raw);
    default:
      return null;
  }
}

function parseRecordingView(
  raw: unknown,
):
  | (BakeryRecordingCameraView &
      Readonly<{ doorInspection: BakeryDoorInspection }>)
  | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["camera", "doorInspection"]) ||
    !recordingCamera(raw.camera) ||
    !isRecord(raw.doorInspection)
  )
    return null;
  const door = raw.doorInspection;
  if (
    (door.kind === "unavailable" || door.kind === "recorded") &&
    hasExactKeys(door, ["kind"])
  )
    return { camera: raw.camera, doorInspection: { kind: door.kind } };
  if (
    door.kind === "preview" &&
    hasExactKeys(door, ["kind", "degrees"]) &&
    doorDegrees(door.degrees)
  )
    return {
      camera: raw.camera,
      doorInspection: { kind: "preview", degrees: door.degrees },
    };
  return null;
}

function parseCameraView(raw: unknown): BakeryCameraView | null {
  const view = parseRecordingCameraView(raw);
  if (
    view === null ||
    (view.camera !== "perspective" && view.camera !== "overhead")
  )
    return null;
  return { camera: view.camera };
}

function parseShift(
  raw: Readonly<Record<string, unknown>>,
): Variant<BakerySurfaceContextV1["active"], "shift"> | null {
  const view = parseShiftView(raw.view);
  if (
    view === null ||
    !hasExactKeys(raw, [
      "kind",
      "view",
      "source",
      "sourceIdentity",
      "variant",
      "selection",
      "selectedTask",
      "playback",
      "draft",
      "pendingEdit",
      "scenarioSaveProposal",
      "run",
      ...(raw.layout === undefined ? [] : ["layout"]),
    ]) ||
    (raw.source !== "sample" && raw.source !== "procedure") ||
    (raw.variant !== "normal" && raw.variant !== "outage")
  )
    return null;
  const selection = parseSelection(raw.selection);
  const sourceIdentity = parseSourceIdentity(raw.sourceIdentity);
  const selectedTask =
    raw.selectedTask === null ? null : parseTaskDetail(raw.selectedTask);
  const playback = parsePlayback(raw.playback);
  const draft = parseDraftReference(raw.draft);
  const pendingEdit =
    raw.pendingEdit === null ? null : parseEditProposal(raw.pendingEdit);
  const scenarioSaveProposal =
    raw.scenarioSaveProposal === null
      ? null
      : parseScenarioSaveManifest(raw.scenarioSaveProposal);
  const layout =
    raw.layout === undefined ? undefined : parseShiftLayout(raw.layout);
  if (
    !isRecord(raw.run) ||
    layout === null ||
    selection === null ||
    sourceIdentity === null ||
    sourceIdentity.kind !== raw.source ||
    (raw.selectedTask !== null && selectedTask === null) ||
    playback === null ||
    draft === null ||
    (raw.pendingEdit !== null && pendingEdit === null) ||
    (raw.scenarioSaveProposal !== null && scenarioSaveProposal === null)
  )
    return null;
  if (
    !hasExactKeys(raw.run, [
      "state",
      "endSeconds",
      "lateBatches",
      "unfinishedBatches",
    ]) ||
    (raw.run.state !== "complete" &&
      raw.run.state !== "blocked" &&
      raw.run.state !== "horizon") ||
    !seconds(raw.run.endSeconds) ||
    !isNonNegativeInteger(raw.run.lateBatches) ||
    !isNonNegativeInteger(raw.run.unfinishedBatches)
  )
    return null;
  return {
    kind: "shift",
    view,
    source: raw.source,
    sourceIdentity,
    variant: raw.variant,
    selection,
    selectedTask,
    playback,
    draft,
    pendingEdit,
    scenarioSaveProposal,
    run: {
      state: raw.run.state,
      endSeconds: raw.run.endSeconds,
      lateBatches: raw.run.lateBatches,
      unfinishedBatches: raw.run.unfinishedBatches,
    },
    ...(layout === undefined ? {} : { layout }),
  };
}

function parseRehearsal(
  raw: Readonly<Record<string, unknown>>,
): Variant<BakerySurfaceContextV1["active"], "rehearsal"> | null {
  if (raw.rehearsalKind === "scheduled") return parseScheduledRehearsal(raw);
  const view = parseRecordingView(raw.view);
  if (view === null) return null;
  if (
    !hasExactKeys(raw, [
      "kind",
      "view",
      "rehearsalKind",
      "readiness",
      "selection",
      "playback",
      "runId",
      "attemptId",
      "tasks",
      "resources",
      "candidate",
      "runSaveProposal",
      ...(raw.rackLayout === undefined ? [] : ["rackLayout"]),
    ]) ||
    (raw.rehearsalKind !== "standalone" && raw.rehearsalKind !== "trays") ||
    (raw.readiness !== "empty" &&
      raw.readiness !== "setup" &&
      raw.readiness !== "ready") ||
    (raw.runId !== null && !identifier(raw.runId)) ||
    (raw.attemptId !== null && !identifier(raw.attemptId)) ||
    !Array.isArray(raw.tasks) ||
    !Array.isArray(raw.resources)
  )
    return null;
  const rackLayout =
    raw.rackLayout == null ? null : parseRackLayoutContext(raw.rackLayout);
  if (raw.rackLayout != null && rackLayout === null) return null;
  const selection =
    raw.selection === null ? null : parseSelection(raw.selection);
  const playback = parsePlayback(raw.playback);
  const tasks = parseSummaries(raw.tasks);
  const resources = parseSummaries(raw.resources);
  const candidate =
    raw.candidate === null
      ? null
      : parseRecordingAcceptanceReference(raw.candidate);
  const runSaveProposal =
    raw.runSaveProposal === null
      ? null
      : parseRunSaveManifest(raw.runSaveProposal);
  if (
    (raw.selection !== null && selection === null) ||
    playback === null ||
    tasks === null ||
    resources === null ||
    (raw.candidate !== null && candidate === null) ||
    (raw.runSaveProposal !== null && runSaveProposal === null) ||
    (candidate !== null &&
      candidate.kind !== (raw.rehearsalKind === "trays" ? "trays" : "workcell"))
  )
    return null;
  return {
    kind: "rehearsal",
    view,
    rackLayout,
    rehearsalKind: raw.rehearsalKind,
    readiness: raw.readiness,
    selection,
    playback,
    runId: raw.runId,
    attemptId: raw.attemptId,
    tasks,
    resources,
    candidate,
    runSaveProposal,
  };
}

function parseScheduledRehearsal(
  raw: Readonly<Record<string, unknown>>,
): BakerySurfaceScheduledRehearsal | null {
  const view = parseCameraView(raw.view);
  if (view === null) return null;
  const panel = parseBakeryProductionPanel(raw.panel);
  if (
    panel === null ||
    !hasExactKeys(raw, [
      "kind",
      "view",
      "panel",
      "rehearsalKind",
      "rackLayout",
      "readiness",
      "selection",
      "playback",
      "runId",
      "attemptId",
      "planFingerprint",
      "pendingOperation",
      "tasks",
      "resources",
      "trays",
      "bakerCount",
      "faults",
      "editReview",
      "candidate",
      "runSaveProposal",
    ]) ||
    (raw.readiness !== "empty" && raw.readiness !== "ready") ||
    !Number.isInteger(raw.bakerCount) ||
    (raw.bakerCount as number) < 0 ||
    (raw.bakerCount as number) > 16 ||
    raw.runId !== null ||
    raw.attemptId !== null ||
    (raw.planFingerprint !== null && !identifier(raw.planFingerprint)) ||
    (raw.readiness === "ready") !== (raw.planFingerprint !== null) ||
    !Array.isArray(raw.tasks) ||
    !Array.isArray(raw.resources)
  )
    return null;
  let rackLayout: BakerySurfaceTrayLayout | null = null;
  if (raw.rackLayout !== null) {
    if (!isRecord(raw.rackLayout) || !identifier(raw.rackLayout.operationId))
      return null;
    const { operationId, ...layout } = raw.rackLayout;
    const parsed = parseRackLayoutContext(layout);
    if (parsed === null) return null;
    rackLayout = { ...parsed, operationId };
  }
  const pendingOperation = parsePendingOperation(raw.pendingOperation);
  if (raw.pendingOperation !== null && pendingOperation === null) return null;
  const selection =
    raw.selection === null ? null : parseSelection(raw.selection);
  const playback = parsePlayback(raw.playback);
  const tasks = parseSummaries(raw.tasks);
  const resources = parseSummaries(raw.resources);
  const trays = parseRehearsalTrays(raw.trays);
  const faults = parseRehearsalFaults(raw.faults);
  const editReview =
    raw.editReview === null ? null : parseRehearsalReview(raw.editReview);
  if (raw.editReview !== null && editReview === null) return null;
  const candidate =
    raw.candidate === null
      ? null
      : parseRecordingAcceptanceReference(raw.candidate);
  const runSaveProposal =
    raw.runSaveProposal === null
      ? null
      : parseRunSaveManifest(raw.runSaveProposal);
  if (
    (raw.selection !== null && selection === null) ||
    playback === null ||
    tasks === null ||
    resources === null ||
    trays === null ||
    faults === null ||
    (raw.candidate !== null && candidate === null) ||
    (candidate !== null && candidate.kind !== "production") ||
    (raw.runSaveProposal !== null && runSaveProposal === null)
  )
    return null;
  return {
    kind: "rehearsal",
    view,
    rehearsalKind: "scheduled",
    panel,
    rackLayout,
    readiness: raw.readiness,
    selection,
    playback,
    runId: null,
    attemptId: null,
    planFingerprint: raw.planFingerprint,
    pendingOperation,
    tasks,
    resources,
    trays,
    faults,
    editReview,
    bakerCount: raw.bakerCount as number,
    candidate,
    runSaveProposal,
  };
}

function parsePendingOperation(
  raw: unknown,
): BakerySurfacePendingOperation | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["operationId", "label", "mode"]) ||
    !identifier(raw.operationId) ||
    !label(raw.label) ||
    !simulationMode(raw.mode)
  )
    return null;
  return { operationId: raw.operationId, label: raw.label, mode: raw.mode };
}

function parseProduction(
  raw: Readonly<Record<string, unknown>>,
): Variant<BakerySurfaceContextV1["active"], "production"> | null {
  const view = parseCameraView(raw.view);
  if (view === null) return null;
  const panel = parseBakeryProductionPanel(raw.panel);
  if (
    panel === null ||
    !hasExactKeys(raw, [
      "kind",
      "view",
      "panel",
      "pendingOperation",
      "readiness",
      "planFingerprint",
      "variant",
      "operationCount",
      "operations",
      "selection",
      "playback",
      "candidate",
      "scenarioSaveProposal",
      "draft",
    ]) ||
    (raw.readiness !== "loading" &&
      raw.readiness !== "failed" &&
      raw.readiness !== "ready") ||
    (raw.planFingerprint !== null && !identifier(raw.planFingerprint)) ||
    (raw.variant !== null &&
      raw.variant !== "normal" &&
      raw.variant !== "outage") ||
    !isNonNegativeInteger(raw.operationCount) ||
    !Array.isArray(raw.operations)
  )
    return null;
  const pendingOperation = parsePendingOperation(raw.pendingOperation);
  if (raw.pendingOperation !== null && pendingOperation === null) return null;
  const operations = parseSummaries(raw.operations);
  const candidate =
    raw.candidate === null
      ? null
      : parseRecordingAcceptanceReference(raw.candidate);
  const scenarioSaveProposal =
    raw.scenarioSaveProposal === null
      ? null
      : parseScenarioSaveManifest(raw.scenarioSaveProposal);
  if (raw.scenarioSaveProposal !== null && scenarioSaveProposal === null)
    return null;
  if (raw.candidate !== null && candidate === null) return null;
  if (candidate !== null && candidate.kind !== "production") return null;
  if (operations === null || operations.length !== raw.operationCount)
    return null;
  if (raw.readiness === "loading" || raw.readiness === "failed") {
    if (
      pendingOperation !== null ||
      raw.planFingerprint !== null ||
      raw.variant !== null ||
      raw.operationCount !== 0 ||
      operations.length !== 0 ||
      raw.selection !== null ||
      raw.playback !== null ||
      candidate !== null ||
      raw.draft !== null
    )
      return null;
    return {
      kind: "production",
      view,
      panel,
      pendingOperation: null,
      readiness: raw.readiness,
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
  }
  if (raw.planFingerprint === null || raw.variant === null) return null;
  const selection = parseSelection(raw.selection);
  const playback = parsePlayback(raw.playback);
  const draft = raw.draft === null ? null : parseProductionDraft(raw.draft);
  if (
    selection === null ||
    playback === null ||
    (raw.draft !== null && draft === null)
  )
    return null;
  return {
    kind: "production",
    view,
    panel,
    pendingOperation,
    readiness: "ready",
    planFingerprint: raw.planFingerprint,
    variant: raw.variant,
    operationCount: raw.operationCount,
    operations,
    selection,
    playback,
    candidate,
    scenarioSaveProposal,
    draft,
  };
}

function parseSelection(raw: unknown): BakerySurfaceSelection | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["kind", "id", "label"]) ||
    (raw.kind !== "batch" &&
      raw.kind !== "station" &&
      raw.kind !== "task" &&
      raw.kind !== "resource" &&
      raw.kind !== "operation") ||
    !identifier(raw.id) ||
    !label(raw.label)
  )
    return null;
  return { kind: raw.kind, id: raw.id, label: raw.label };
}

function parseSourceIdentity(
  raw: unknown,
): Variant<BakerySurfaceContextV1["active"], "shift">["sourceIdentity"] | null {
  if (!isRecord(raw) || typeof raw.kind !== "string") return null;
  if (raw.kind === "sample")
    return hasExactKeys(raw, ["kind", "id"]) && raw.id === "financier-sample"
      ? { kind: "sample", id: "financier-sample" }
      : null;
  if (
    raw.kind !== "procedure" ||
    !hasExactKeys(raw, ["kind", "id", "revision", "snapshotRevision"]) ||
    !identifier(raw.id) ||
    !identifier(raw.revision) ||
    !identifier(raw.snapshotRevision)
  )
    return null;
  return {
    kind: "procedure",
    id: raw.id,
    revision: raw.revision,
    snapshotRevision: raw.snapshotRevision,
  };
}

function parseTaskDetail(raw: unknown): BakerySurfaceTaskDetail | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "id",
      "name",
      "kind",
      "status",
      "startSeconds",
      "endSeconds",
      "batchId",
      "dependencies",
      "resources",
      "constraints",
    ]) ||
    !identifier(raw.id) ||
    !label(raw.name) ||
    (raw.kind !== "process" &&
      raw.kind !== "transfer" &&
      raw.kind !== "handoff" &&
      raw.kind !== "native") ||
    (raw.status !== "pending" &&
      raw.status !== "running" &&
      raw.status !== "complete") ||
    !seconds(raw.startSeconds) ||
    !seconds(raw.endSeconds) ||
    raw.endSeconds < raw.startSeconds ||
    !identifier(raw.batchId)
  )
    return null;
  const dependencies = parseLabels(raw.dependencies, 8);
  const resources = parseLabels(raw.resources, 8);
  const constraints = parseLabels(raw.constraints, 8);
  if (dependencies === null || resources === null || constraints === null)
    return null;
  return {
    id: raw.id,
    name: raw.name,
    kind: raw.kind,
    status: raw.status,
    startSeconds: raw.startSeconds,
    endSeconds: raw.endSeconds,
    batchId: raw.batchId,
    dependencies,
    resources,
    constraints,
  };
}

function parseDraftSnapshot(raw: unknown): BakerySurfaceDraftSnapshot | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["kind", "draft"]) ||
    raw.kind !== "draft" ||
    !isRecord(raw.draft) ||
    !hasExactKeys(raw.draft, ["reference", "values"]) ||
    !isRecord(raw.draft.values)
  )
    return null;
  const reference = parseDraftReference(raw.draft.reference);
  if (reference === null || !hasExactKeys(raw.draft.values, SETTINGS_FIELDS))
    return null;
  const values = {} as Record<SettingsField, number>;
  for (const field of SETTINGS_FIELDS) {
    const value = raw.draft.values[field];
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    values[field] = value;
  }
  return { reference, values };
}

function parseLabels(raw: unknown, limit: number): readonly string[] | null {
  if (!Array.isArray(raw) || raw.length > limit || !raw.every(label))
    return null;
  return raw;
}

export function parseEffectOutcome(raw: unknown): BakerySurfaceEffectOutcomeV1 | null {
  if (
    isRecord(raw) &&
    raw.kind === "prepared" &&
    hasExactKeys(raw, ["kind", "binding", "surface"])
  ) {
    const binding = parseBakeryBrowserBinding(raw.binding);
    const surface = parseBakerySurfaceAttachment(raw.surface);
    return binding !== null && surface.kind === "valid"
      ? { kind: "prepared", binding, surface: surface.value }
      : null;
  }
  if (!isRecord(raw) || typeof raw.kind !== "string") return null;
  if (raw.kind === "completed") {
    if (!hasExactKeys(raw, ["kind", "result"])) return null;
    const result = parseCommandResult(raw.result);
    return result === null ? null : { kind: "completed", result };
  }
  if (raw.kind === "page_completed") {
    if (!hasExactKeys(raw, ["kind", "observation"])) return null;
    const observation = parseSurfaceObservation(raw.observation);
    return observation === null
      ? null
      : { kind: "page_completed", observation };
  }
  if (raw.kind === "page_rejected")
    return hasExactKeys(raw, ["kind", "message"]) && label(raw.message)
      ? { kind: "page_rejected", message: raw.message }
      : null;
  if (
    raw.kind !== "delivery_failed" ||
    !hasExactKeys(raw, ["kind", "code", "message"]) ||
    (raw.code !== "effect_invalid" &&
      raw.code !== "effect_expired" &&
      raw.code !== "effect_cancelled" &&
      raw.code !== "effect_indeterminate" &&
      raw.code !== "effect_conflict" &&
      raw.code !== "surface_unavailable" &&
      raw.code !== "ledger_full") ||
    !label(raw.message)
  )
    return null;
  return { kind: "delivery_failed", code: raw.code, message: raw.message };
}

function parseCommandResult(raw: unknown): BakerySurfaceCommandResultV1 | null {
  if (!isRecord(raw) || typeof raw.kind !== "string") return null;
  if (raw.kind === "succeeded") {
    if (
      !hasExactKeys(raw, ["kind", "command", "surface", "output"]) ||
      !surfaceCommandName(raw.command)
    )
      return null;
    const surface = parseBakerySurfaceAttachment(raw.surface);
    if (surface.kind === "invalid" || !isRecord(raw.output)) return null;
    if (raw.command === "file_action") {
      if (
        !hasExactKeys(raw.output, ["kind", "action", "manifest"]) ||
        raw.output.kind !== "file" ||
        (raw.output.action !== "import" && raw.output.action !== "export")
      )
        return null;
      const manifest = parseBakeryFileManifest(raw.output.manifest);
      return manifest === null
        ? null
        : {
            kind: "succeeded",
            command: "file_action",
            surface: surface.value,
            output: { kind: "file", action: raw.output.action, manifest },
          };
    }
    if (raw.command === "inspect_scenario_save") {
      if (
        !hasExactKeys(raw.output, ["kind", "save"]) ||
        raw.output.kind !== "scenario_save_inspection"
      )
        return null;
      const save = parseScenarioSaveInspection(raw.output.save);
      return save === null
        ? null
        : {
            kind: "succeeded",
            command: "inspect_scenario_save",
            surface: surface.value,
            output: { kind: "scenario_save_inspection", save },
          };
    }
    if (raw.command === "inspect_run_save") {
      if (
        !hasExactKeys(raw.output, ["kind", "runKind", "save"]) ||
        raw.output.kind !== "run_save_inspection" ||
        (raw.output.runKind !== "rehearsal" &&
          raw.output.runKind !== "production")
      )
        return null;
      const save = parseRunSaveInspection(raw.output.save);
      return save === null
        ? null
        : {
            kind: "succeeded",
            command: "inspect_run_save",
            surface: surface.value,
            output: {
              kind: "run_save_inspection",
              runKind: raw.output.runKind,
              save,
            },
          };
    }
    if (raw.command === "list_saved_runs") {
      if (
        !hasExactKeys(raw.output, ["kind", "runKind", "cursor", "page"]) ||
        raw.output.kind !== "saved_runs" ||
        !isRunSnapshotCursor(raw.output.cursor) ||
        (raw.output.runKind !== "rehearsal" &&
          raw.output.runKind !== "production")
      )
        return null;
      const page = parseRunSnapshotPage(raw.output.page);
      if (page === null) return null;
      for (const snapshot of page.snapshots)
        if (snapshot.kind !== raw.output.runKind) return null;
      return {
        kind: "succeeded",
        command: "list_saved_runs",
        surface: surface.value,
        output: {
          kind: "saved_runs",
          runKind: raw.output.runKind,
          cursor: raw.output.cursor,
          page,
        },
      };
    }
    if (raw.command === "read_draft") {
      const draft = parseDraftSnapshot(raw.output);
      return draft === null
        ? null
        : {
            kind: "succeeded",
            command: "read_draft",
            surface: surface.value,
            output: { kind: "draft", draft },
          };
    }
    if (raw.command === "query_tasks") {
      if (
        !hasExactKeys(raw.output, ["kind", "tasks"]) ||
        raw.output.kind !== "task_query" ||
        !Array.isArray(raw.output.tasks) ||
        raw.output.tasks.length > MAX_SUMMARIES
      )
        return null;
      const tasks: BakerySurfaceTaskDetail[] = [];
      for (const candidate of raw.output.tasks) {
        const task = parseTaskDetail(candidate);
        if (task === null) return null;
        tasks.push(task);
      }
      return {
        kind: "succeeded",
        command: "query_tasks",
        surface: surface.value,
        output: { kind: "task_query", tasks },
      };
    }
    if (raw.command === "prepare_run_save") {
      if (
        !hasExactKeys(raw.output, ["kind", "manifest"]) ||
        raw.output.kind !== "run_save_proposal"
      )
        return null;
      const manifest = parseRunSaveManifest(raw.output.manifest);
      return manifest === null
        ? null
        : {
            kind: "succeeded",
            command: "prepare_run_save",
            surface: surface.value,
            output: { kind: "run_save_proposal", manifest },
          };
    }
    if (raw.command === "prepare_scenario_save") {
      if (
        !hasExactKeys(raw.output, ["kind", "manifest"]) ||
        raw.output.kind !== "scenario_save_proposal"
      )
        return null;
      const manifest = parseScenarioSaveManifest(raw.output.manifest);
      return manifest === null
        ? null
        : {
            kind: "succeeded",
            command: "prepare_scenario_save",
            surface: surface.value,
            output: { kind: "scenario_save_proposal", manifest },
          };
    }
    if (raw.command === "simulate_workcell") {
      const output = parseSimulationOutput(raw.output);
      return output === null
        ? null
        : {
            kind: "succeeded",
            command: "simulate_workcell",
            surface: surface.value,
            output,
          };
    }
    if (!hasExactKeys(raw.output, ["kind"]) || raw.output.kind !== "surface")
      return null;
    return {
      kind: "succeeded",
      command: raw.command,
      surface: surface.value,
      output: { kind: "surface" },
    };
  }
  if (
    raw.kind !== "rejected" ||
    !hasExactKeys(raw, ["kind", "command", "code", "message"]) ||
    !surfaceCommandName(raw.command) ||
    (raw.code !== "stale_surface" &&
      raw.code !== "stale_draft" &&
      raw.code !== "unsupported_command" &&
      raw.code !== "target_not_found" &&
      raw.code !== "invalid_edit" &&
      raw.code !== "proposal_missing" &&
      raw.code !== "simulation_failed") ||
    !label(raw.message)
  )
    return null;
  return {
    kind: "rejected",
    command: raw.command,
    code: raw.code,
    message: raw.message,
  };
}

export function parseSurfaceReference(raw: unknown): BakerySurfaceReference | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["surfaceSessionId", "surfaceEpoch"]) ||
    !identifier(raw.surfaceSessionId) ||
    !isNonNegativeInteger(raw.surfaceEpoch)
  )
    return null;
  return {
    surfaceSessionId: raw.surfaceSessionId,
    surfaceEpoch: raw.surfaceEpoch,
  };
}

export function parseRecordingAcceptanceReference(
  raw: unknown,
): BakeryRecordingAcceptanceReference | null {
  if (
    !isRecord(raw) ||
    !identifier(raw.surfaceSessionId) ||
    !isNonNegativeInteger(raw.surfaceEpoch) ||
    typeof raw.recordingDigest !== "string" ||
    !SHA256_PATTERN.test(raw.recordingDigest)
  )
    return null;
  const identity = {
    surfaceSessionId: raw.surfaceSessionId,
    surfaceEpoch: raw.surfaceEpoch,
    recordingDigest: raw.recordingDigest,
  };
  if (raw.kind === "workcell") {
    if (
      !hasExactKeys(raw, [
        "kind",
        "surfaceSessionId",
        "surfaceEpoch",
        "recordingDigest",
        "inputFingerprint",
      ]) ||
      typeof raw.inputFingerprint !== "string" ||
      !SHA256_PATTERN.test(raw.inputFingerprint)
    )
      return null;
    return {
      ...identity,
      kind: "workcell",
      inputFingerprint: raw.inputFingerprint,
    };
  }
  if (raw.kind === "trays") {
    if (
      !hasExactKeys(raw, [
        "kind",
        "surfaceSessionId",
        "surfaceEpoch",
        "recordingDigest",
        "operationId",
        "runFingerprint",
      ]) ||
      !identifier(raw.operationId) ||
      typeof raw.runFingerprint !== "string" ||
      !SHA256_PATTERN.test(raw.runFingerprint)
    )
      return null;
    return {
      ...identity,
      kind: "trays",
      operationId: raw.operationId,
      runFingerprint: raw.runFingerprint,
    };
  }
  if (raw.kind === "production") {
    if (
      !hasExactKeys(raw, [
        "kind",
        "surfaceSessionId",
        "surfaceEpoch",
        "recordingDigest",
        "operationId",
        "planFingerprint",
      ]) ||
      !identifier(raw.operationId) ||
      !identifier(raw.planFingerprint)
    )
      return null;
    return {
      ...identity,
      kind: "production",
      operationId: raw.operationId,
      planFingerprint: raw.planFingerprint,
    };
  }
  return null;
}

export function parseDraftReference(raw: unknown): BakerySurfaceDraftReference | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["revision", "digest"]) ||
    !isNonNegativeInteger(raw.revision) ||
    typeof raw.digest !== "string" ||
    !SHA256_PATTERN.test(raw.digest)
  )
    return null;
  return { revision: raw.revision, digest: raw.digest };
}

export function parseEditOperations(
  raw: unknown,
): BakerySurfaceEditOperation[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8) return null;
  const edits: BakerySurfaceEditOperation[] = [];
  const fields = new Set<SettingsField>();
  for (const value of raw) {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ["kind", "field", "value"]) ||
      value.kind !== "set_assumption" ||
      !settingsField(value.field) ||
      typeof value.value !== "number" ||
      !Number.isFinite(value.value) ||
      fields.has(value.field)
    )
      return null;
    fields.add(value.field);
    edits.push({
      kind: "set_assumption",
      field: value.field,
      value: value.value,
    });
  }
  return edits;
}

function parseEditProposal(raw: unknown): BakerySurfaceEditProposalV1 | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "proposalDigest",
      "baseDraft",
      "edits",
      "summary",
      "preview",
    ]) ||
    typeof raw.proposalDigest !== "string" ||
    !SHA256_PATTERN.test(raw.proposalDigest) ||
    !Array.isArray(raw.summary) ||
    raw.summary.length === 0 ||
    raw.summary.length > 8
  )
    return null;
  const baseDraft = parseDraftReference(raw.baseDraft);
  const edits = parseEditOperations(raw.edits);
  if (
    baseDraft === null ||
    edits === null ||
    !raw.summary.every(label) ||
    !isRecord(raw.preview) ||
    !hasExactKeys(raw.preview, ["before", "after"])
  )
    return null;
  const before = parseRunPreview(raw.preview.before);
  const after = parseRunPreview(raw.preview.after);
  if (before === null || after === null) return null;
  return {
    proposalDigest: raw.proposalDigest,
    baseDraft,
    edits,
    summary: raw.summary,
    preview: { before, after },
  };
}

function parseRunPreview(raw: unknown): BakerySurfaceRunPreview | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "state",
      "endSeconds",
      "lateBatches",
      "unfinishedBatches",
    ]) ||
    (raw.state !== "complete" &&
      raw.state !== "blocked" &&
      raw.state !== "horizon") ||
    !seconds(raw.endSeconds) ||
    !isNonNegativeInteger(raw.lateBatches) ||
    !isNonNegativeInteger(raw.unfinishedBatches)
  )
    return null;
  return {
    state: raw.state,
    endSeconds: raw.endSeconds,
    lateBatches: raw.lateBatches,
    unfinishedBatches: raw.unfinishedBatches,
  };
}

function parseRunSaveManifest(
  raw: unknown,
): BakerySurfaceRunSaveManifest | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["kind", "id", "name", "bytes"]) ||
    raw.kind !== "rehearsal" ||
    typeof raw.id !== "string" ||
    !SHA256_PATTERN.test(raw.id) ||
    typeof raw.name !== "string" ||
    raw.name.trim().length === 0 ||
    raw.name.length > 80 ||
    !isNonNegativeInteger(raw.bytes) ||
    raw.bytes > MAX_RUN_SNAPSHOT_BYTES
  )
    return null;
  return {
    kind: "rehearsal",
    id: raw.id,
    name: raw.name,
    bytes: raw.bytes,
  };
}

export function parseScenarioSaveManifest(
  raw: unknown,
): BakerySurfaceScenarioSaveManifest | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "kind",
      "id",
      "name",
      "sourceFingerprint",
      "digest",
      "bytes",
    ]) ||
    (raw.kind !== "scenario" && raw.kind !== "production-scenario") ||
    !identifier(raw.id) ||
    typeof raw.name !== "string" ||
    raw.name.trim().length === 0 ||
    raw.name.length > 80 ||
    typeof raw.sourceFingerprint !== "string" ||
    !SHA256_PATTERN.test(raw.sourceFingerprint) ||
    typeof raw.digest !== "string" ||
    !SHA256_PATTERN.test(raw.digest) ||
    !isNonNegativeInteger(raw.bytes) ||
    raw.bytes > 64 * 1024
  )
    return null;
  return {
    kind: raw.kind,
    id: raw.id,
    name: raw.name,
    sourceFingerprint: raw.sourceFingerprint,
    digest: raw.digest,
    bytes: raw.bytes,
  };
}

export function surfaceCommandName(
  value: unknown,
): value is BakerySurfaceCommandName {
  return (
    value === "inspect_surface" ||
    value === "read_draft" ||
    value === "query_tasks" ||
    value === "set_view" ||
    value === "control_baseline" ||
    value === "show_production_panel" ||
    value === "control_workspace_view" ||
    value === "control_playback" ||
    value === "prepare_workcell" ||
    value === "prepare_layout" ||
    value === "prepare_production_control" ||
    value === "prepare_edit" ||
    value === "run_shift" ||
    value === "select_item" ||
    value === "rotate_equipment" ||
    value === "set_equipment_angle" ||
    value === "move_equipment" ||
    value === "toggle_opening" ||
    value === "select_floor_plan" ||
    value === "configure_interior" ||
    value === "reset_floor_plan" ||
    value === "compare_shift" ||
    value === "start_production" ||
    value === "prepare_run_save" ||
    value === "file_action" ||
    value === "inspect_scenario_save" ||
    value === "inspect_run_save" ||
    value === "list_saved_runs" ||
    value === "prepare_run_open" ||
    value === "prepare_scenario_save" ||
    value === "stop_simulation" ||
    value === "simulate_workcell" ||
    value === "accept_candidate" ||
    value === "discard_candidate" ||
    value === "edit_rehearsal" ||
    value === "edit_production" ||
    value === "preview_production" ||
    value === "apply_production" ||
    value === "apply_reviewed_edit"
  );
}

export function simulationMode(value: unknown): value is BakerySimulationMode {
  return (
    value === "transfer" || value === "oven-cycle" || value === "rack-cycle"
  );
}

export function parseTaskFilter(
  raw: unknown,
): Variant<BakerySurfaceCommandV1, "query_tasks">["filter"] | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["text", "limit"]) ||
    typeof raw.text !== "string" ||
    raw.text.trim().length === 0 ||
    raw.text.length > MAX_LABEL_LENGTH ||
    typeof raw.limit !== "number" ||
    !Number.isSafeInteger(raw.limit) ||
    raw.limit < 1 ||
    raw.limit > 8
  )
    return null;
  return { text: raw.text.trim(), limit: raw.limit };
}

function settingsField(value: unknown): value is SettingsField {
  switch (value) {
    case "batchCount":
    case "workerCount":
    case "rackTrays":
    case "ovenTrays":
    case "traysPerBatch":
    case "piecesPerTray":
    case "loadWindow":
    case "loadSeconds":
    case "unloadSeconds":
    case "stage":
    case "portion":
    case "bake":
    case "cool":
    case "demould":
    case "finishCooling":
    case "pack":
    case "horizonMinutes":
    case "outageStart":
    case "outageEnd":
      return true;
    default:
      return false;
  }
}

export function parseView(
  raw: unknown,
): Variant<BakerySurfaceCommandV1, "set_view">["view"] | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["selection", "cursorSeconds", "playback"]) ||
    raw.playback !== "paused" ||
    !seconds(raw.cursorSeconds)
  )
    return null;
  const selection = parseSelectionTarget(raw.selection);
  return selection === null
    ? null
    : {
        selection,
        cursorSeconds: raw.cursorSeconds,
        playback: "paused",
      };
}

export function parseSelectionTarget(
  raw: unknown,
): BakerySurfaceSelectionTarget | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["kind", "id"]) ||
    (raw.kind !== "batch" &&
      raw.kind !== "station" &&
      raw.kind !== "task" &&
      raw.kind !== "resource" &&
      raw.kind !== "operation") ||
    !identifier(raw.id)
  )
    return null;
  return { kind: raw.kind, id: raw.id };
}

function parsePlayback(raw: unknown): BakerySurfacePlayback | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["cursorSeconds", "playback", "speed"]) ||
    !seconds(raw.cursorSeconds) ||
    (raw.playback !== "paused" && raw.playback !== "playing") ||
    typeof raw.speed !== "number" ||
    !Number.isFinite(raw.speed) ||
    raw.speed <= 0 ||
    raw.speed > 1000
  )
    return null;
  return {
    cursorSeconds: raw.cursorSeconds,
    playback: raw.playback,
    speed: raw.speed,
  };
}

function parseSummaries(
  raw: readonly unknown[],
): BakerySurfaceSummary[] | null {
  if (raw.length > MAX_SUMMARIES) return null;
  const summaries: BakerySurfaceSummary[] = [];
  for (const value of raw) {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ["id", "label", "state"]) ||
      !identifier(value.id) ||
      !label(value.label) ||
      !label(value.state)
    )
      return null;
    summaries.push({
      id: value.id,
      label: value.label,
      state: value.state,
    });
  }
  return summaries;
}

function seconds(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function invalid(message: string): BakerySurfaceParseResult {
  return { kind: "invalid", message };
}

export function invalidCommand(message: string): BakerySurfaceCommandParseResult {
  return { kind: "invalid", message };
}

export function invalidEffect(message: string): BakerySurfaceEffectParseResult {
  return { kind: "invalid", message };
}

export function invalidReceipt(message: string): BakerySurfaceReceiptParseResult {
  return { kind: "invalid", message };
}

export function layoutOffset(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= -600 &&
    value <= 600
  );
}

function parseRackLayoutContext(
  value: unknown,
): BakerySurfaceRackLayout | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "modelHash",
      "xMm",
      "yMm",
      "editable",
      "checks",
      "proposal",
    ]) ||
    typeof value.modelHash !== "string" ||
    !SHA256_PATTERN.test(value.modelHash) ||
    !layoutOffset(value.xMm) ||
    !layoutOffset(value.yMm) ||
    typeof value.editable !== "boolean" ||
    !label(value.checks)
  )
    return null;
  let proposal: BakerySurfaceRackLayout["proposal"] = null;
  if (value.proposal !== null) {
    const raw = value.proposal;
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, ["baseModelHash", "xMm", "yMm", "status"]) ||
      typeof raw.baseModelHash !== "string" ||
      !SHA256_PATTERN.test(raw.baseModelHash) ||
      !layoutOffset(raw.xMm) ||
      !layoutOffset(raw.yMm) ||
      (raw.status !== "blocked" && raw.status !== "unchecked")
    )
      return null;
    proposal = {
      baseModelHash: raw.baseModelHash,
      xMm: raw.xMm,
      yMm: raw.yMm,
      status: raw.status,
    };
  }
  return {
    modelHash: value.modelHash,
    xMm: value.xMm,
    yMm: value.yMm,
    editable: value.editable,
    checks: value.checks,
    proposal,
  };
}

function parseRunSaveInspection(raw: unknown): BakeryRunSaveInspection | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "idle")
    return hasExactKeys(raw, ["kind"]) ? { kind: "idle" } : null;
  const ref = raw.reference;
  if (
    !isRecord(ref) ||
    !hasExactKeys(ref, ["id", "name", "requestId", "origin"]) ||
    !isRunSnapshotId(ref.id) ||
    typeof ref.name !== "string" ||
    ref.name.length === 0 ||
    ref.name.length > 80 ||
    !identifier(ref.requestId) ||
    (ref.origin !== "operator" && ref.origin !== "agent")
  )
    return null;
  const reference: BakeryRunSaveReference = {
    id: ref.id,
    name: ref.name,
    requestId: ref.requestId,
    origin: ref.origin,
  };
  switch (raw.kind) {
    case "saving":
    case "verified":
    case "readback-confirmed":
      return hasExactKeys(raw, ["kind", "reference"])
        ? { kind: raw.kind, reference }
        : null;
    case "outcome-unknown":
    case "saved-readback-failed":
    case "not-found":
      return hasExactKeys(raw, ["kind", "reference", "readback"]) &&
        (raw.readback === "verified" ||
          raw.readback === "missing" ||
          raw.readback === "unavailable")
        ? { kind: raw.kind, reference, readback: raw.readback }
        : null;
    default:
      return null;
  }
}

function parseScenarioSaveInspection(
  raw: unknown,
): BakeryScenarioSaveInspection | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "idle")
    return hasExactKeys(raw, ["kind"]) ? { kind: "idle" } : null;
  const manifest = parseScenarioSaveManifest(raw.manifest);
  if (manifest === null) return null;
  switch (raw.kind) {
    case "prepared":
    case "saving":
    case "failed-before-save":
    case "verified":
      return hasExactKeys(raw, ["kind", "manifest"])
        ? { kind: raw.kind, manifest }
        : null;
    case "outcome-unknown":
    case "saved-readback-failed":
      return hasExactKeys(raw, ["kind", "manifest", "readback"]) &&
        (raw.readback === "verified" || raw.readback === "unavailable")
        ? { kind: raw.kind, manifest, readback: raw.readback }
        : null;
    default:
      return null;
  }
}
function parseBakeryFileManifest(raw: unknown): BakeryFileManifest | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["name", "digest", "bytes"]) ||
    !identifier(raw.name) ||
    typeof raw.digest !== "string" ||
    !SHA256_PATTERN.test(raw.digest) ||
    !isNonNegativeInteger(raw.bytes) ||
    raw.bytes > MAX_RUN_SNAPSHOT_BYTES
  )
    return null;
  return { name: raw.name, digest: raw.digest, bytes: raw.bytes };
}
