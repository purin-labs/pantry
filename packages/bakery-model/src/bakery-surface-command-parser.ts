import {
  parseBakeryProductionControl,
  parseBakeryProductionTarget,
} from "./bakery-persistent-surface.ts";
import {
  floorPlanCoordinateMm,
  floorPlanId,
  isBakeryFloorPlanResetAction,
  parseBakeryStoreInteriorAction,
  rotationDegrees,
} from "./bakery-floor-plan.ts";
import { identifier } from "./bakery-surface-text.ts";
import { parseBakeryWorkspaceViewAction } from "./bakery-surface-view.ts";
import { parseBakeryWorkcellPreparation } from "./bakery-workcell-preparation.ts";
import { parseBakeryPlaybackAction } from "./bakery-playback.ts";
import { isRunSnapshotId, isRunSnapshotCursor } from "./bakery-run-snapshot.ts";
import { hasExactKeys, isRecord } from "@purin-labs/std";
import type {
  BakeryFileAction,
  BakeryProductionEdit,
  BakeryRehearsalChange,
  BakeryRehearsalEdit,
  BakerySurfaceCommandParseResult,
} from "./bakery-surface-types.ts";
import {
  MAX_SUMMARIES,
  SHA256_PATTERN,
  baker,
  invalidCommand,
  layoutOffset,
  parseBakeryProductionPanel,
  parseDraftReference,
  parseEditOperations,
  parseManualTask,
  parseRecordingAcceptanceReference,
  parseRehearsalChange,
  parseRehearsalFaults,
  parseRunComparison,
  parseSelectionTarget,
  parseSimulationReference,
  parseSurfaceReference,
  parseTaskFilter,
  parseView,
  simulationMode,
  smallCount,
  taskLinks,
  wholeSeconds,
} from "./bakery-surface-parsers.ts";

export function parseBakerySurfaceCommand(
  raw: unknown,
): BakerySurfaceCommandParseResult {
  if (!isRecord(raw) || typeof raw.kind !== "string")
    return invalidCommand("The Kitchen surface command is invalid.");
  if (raw.kind === "file_action") {
    const target = parseSurfaceReference(raw.target);
    const action = parseBakeryFileAction(raw.action);
    if (
      !hasExactKeys(raw, ["schemaVersion", "kind", "target", "action"]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      action === null
    )
      return invalidCommand(
        "Choose an attached Kitchen file or an available export.",
      );
    return {
      kind: "valid",
      value: { schemaVersion: 1, kind: "file_action", target, action },
    };
  }
  if (raw.kind === "inspect_scenario_save") {
    const target = parseSurfaceReference(raw.target);
    if (
      !hasExactKeys(raw, ["schemaVersion", "kind", "target"]) ||
      raw.schemaVersion !== 1 ||
      target === null
    )
      return invalidCommand("The scenario save inspection is invalid.");
    return {
      kind: "valid",
      value: { schemaVersion: 1, kind: "inspect_scenario_save", target },
    };
  }
  if (raw.kind === "inspect_run_save") {
    const target = parseSurfaceReference(raw.target);
    if (
      !hasExactKeys(raw, ["schemaVersion", "kind", "target", "runKind"]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      (raw.runKind !== "rehearsal" && raw.runKind !== "production")
    )
      return invalidCommand(
        "Inspect a rehearsal or production save in the attached workspace.",
      );
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "inspect_run_save",
        target,
        runKind: raw.runKind,
      },
    };
  }
  if (raw.kind === "list_saved_runs") {
    const target = parseSurfaceReference(raw.target);
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "runKind",
        "cursor",
      ]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      (raw.runKind !== "rehearsal" && raw.runKind !== "production") ||
      !isRunSnapshotCursor(raw.cursor)
    )
      return invalidCommand(
        "Listing saved runs requires a run kind and an explicit page cursor (null for the first page).",
      );
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "list_saved_runs",
        target,
        runKind: raw.runKind,
        cursor: raw.cursor,
      },
    };
  }
  if (raw.kind === "prepare_run_open") {
    const target = parseSurfaceReference(raw.target);
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "runKind",
        "id",
      ]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      (raw.runKind !== "rehearsal" && raw.runKind !== "production") ||
      !isRunSnapshotId(raw.id)
    )
      return invalidCommand(
        "Opening a saved run requires its exact content ID and kind.",
      );
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "prepare_run_open",
        target,
        runKind: raw.runKind,
        id: raw.id,
      },
    };
  }
  if (raw.kind === "inspect_surface") {
    if (!hasExactKeys(raw, ["schemaVersion", "kind", "target"]))
      return invalidCommand("The Kitchen inspect command is invalid.");
    const target = parseSurfaceReference(raw.target);
    if (raw.schemaVersion !== 1 || target === null)
      return invalidCommand("The Kitchen inspect target is invalid.");
    return {
      kind: "valid",
      value: { schemaVersion: 1, kind: "inspect_surface", target },
    };
  }
  if (raw.kind === "read_draft") {
    if (!hasExactKeys(raw, ["schemaVersion", "kind", "target"]))
      return invalidCommand("The Kitchen draft read command is invalid.");
    const target = parseSurfaceReference(raw.target);
    if (raw.schemaVersion !== 1 || target === null)
      return invalidCommand("The Kitchen draft read target is invalid.");
    return {
      kind: "valid",
      value: { schemaVersion: 1, kind: "read_draft", target },
    };
  }
  if (raw.kind === "query_tasks") {
    if (!hasExactKeys(raw, ["schemaVersion", "kind", "target", "filter"]))
      return invalidCommand("The Kitchen task query is invalid.");
    const target = parseSurfaceReference(raw.target);
    const filter = parseTaskFilter(raw.filter);
    if (raw.schemaVersion !== 1 || target === null || filter === null)
      return invalidCommand("The Kitchen task query is invalid.");
    return {
      kind: "valid",
      value: { schemaVersion: 1, kind: "query_tasks", target, filter },
    };
  }
  if (raw.kind === "stop_simulation") {
    if (!hasExactKeys(raw, ["schemaVersion", "kind", "target", "simulation"]))
      return invalidCommand("The simulation stop command is invalid.");
    const target = parseSurfaceReference(raw.target);
    const simulation = parseSimulationReference(raw.simulation);
    if (raw.schemaVersion !== 1 || target === null || simulation === null)
      return invalidCommand("Stopping requires the exact running simulation.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "stop_simulation",
        target,
        simulation,
      },
    };
  }
  if (raw.kind === "control_workspace_view") {
    if (!hasExactKeys(raw, ["schemaVersion", "kind", "target", "action"]))
      return invalidCommand("The workspace view command is invalid.");
    const target = parseSurfaceReference(raw.target);
    const action = parseBakeryWorkspaceViewAction(raw.action);
    if (raw.schemaVersion !== 1 || target === null || action === null)
      return invalidCommand("The workspace view command is invalid.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "control_workspace_view",
        target,
        action,
      },
    };
  }
  if (raw.kind === "show_production_panel") {
    if (!hasExactKeys(raw, ["schemaVersion", "kind", "target", "panel"]))
      return invalidCommand("The production panel command is invalid.");
    const target = parseSurfaceReference(raw.target);
    const panel = parseBakeryProductionPanel(raw.panel);
    if (raw.schemaVersion !== 1 || target === null || panel === null)
      return invalidCommand("The production panel command is invalid.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "show_production_panel",
        target,
        panel,
      },
    };
  }
  if (raw.kind === "control_baseline") {
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "comparison",
        "action",
      ])
    )
      return invalidCommand("The baseline command is invalid.");
    const target = parseSurfaceReference(raw.target);
    const comparison = parseRunComparison(raw.comparison);
    if (
      raw.schemaVersion !== 1 ||
      target === null ||
      comparison === null ||
      (raw.action !== "pin" && raw.action !== "clear")
    )
      return invalidCommand("The baseline command is invalid.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "control_baseline",
        target,
        comparison,
        action: raw.action,
      },
    };
  }
  if (raw.kind === "control_playback") {
    if (!hasExactKeys(raw, ["schemaVersion", "kind", "target", "action"]))
      return invalidCommand("The Kitchen playback command is invalid.");
    const target = parseSurfaceReference(raw.target);
    const action = parseBakeryPlaybackAction(raw.action);
    if (raw.schemaVersion !== 1 || target === null || action === null)
      return invalidCommand("The Kitchen playback command is invalid.");
    return {
      kind: "valid",
      value: { schemaVersion: 1, kind: "control_playback", target, action },
    };
  }
  if (raw.kind === "prepare_workcell") {
    if (!hasExactKeys(raw, ["schemaVersion", "kind", "target", "preparation"]))
      return invalidCommand("The workcell preparation command is invalid.");
    const target = parseSurfaceReference(raw.target);
    const preparation = parseBakeryWorkcellPreparation(raw.preparation);
    if (raw.schemaVersion !== 1 || target === null || preparation === null)
      return invalidCommand("The workcell preparation command is invalid.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "prepare_workcell",
        target,
        preparation,
      },
    };
  }
  if (raw.kind === "set_view") {
    if (!hasExactKeys(raw, ["schemaVersion", "kind", "target", "view"]))
      return invalidCommand("The Kitchen view command is invalid.");
    const target = parseSurfaceReference(raw.target);
    const view = parseView(raw.view);
    if (raw.schemaVersion !== 1 || target === null || view === null)
      return invalidCommand("The Kitchen view command is invalid.");
    return {
      kind: "valid",
      value: { schemaVersion: 1, kind: "set_view", target, view },
    };
  }
  if (raw.kind === "simulate_workcell" && raw.schemaVersion === 2) {
    const target = parseSurfaceReference(raw.target);
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "operationId",
        "planFingerprint",
        "mode",
      ]) ||
      target === null ||
      !identifier(raw.operationId) ||
      !identifier(raw.planFingerprint) ||
      !simulationMode(raw.mode)
    )
      return invalidCommand("The Kitchen simulation target is invalid.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 2,
        kind: "simulate_workcell",
        target,
        operationId: raw.operationId,
        planFingerprint: raw.planFingerprint,
        mode: raw.mode,
      },
    };
  }
  if (raw.kind === "simulate_workcell") {
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "attemptId",
        "mode",
      ])
    )
      return invalidCommand("The Kitchen simulation command is invalid.");
    const target = parseSurfaceReference(raw.target);
    if (
      raw.schemaVersion !== 1 ||
      target === null ||
      !identifier(raw.attemptId) ||
      !simulationMode(raw.mode)
    )
      return invalidCommand("The Kitchen simulation target is invalid.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "simulate_workcell",
        target,
        attemptId: raw.attemptId,
        mode: raw.mode,
      },
    };
  }
  if (raw.kind === "accept_candidate" || raw.kind === "discard_candidate") {
    if (!hasExactKeys(raw, ["schemaVersion", "kind", "target", "candidate"]))
      return invalidCommand("The Kitchen candidate command is invalid.");
    const target = parseSurfaceReference(raw.target);
    const candidate = parseRecordingAcceptanceReference(raw.candidate);
    if (
      raw.schemaVersion !== 1 ||
      target === null ||
      candidate === null ||
      target.surfaceSessionId !== candidate.surfaceSessionId ||
      target.surfaceEpoch !== candidate.surfaceEpoch
    )
      return invalidCommand(
        "The Kitchen candidate reference is invalid.",
      );
    if (raw.kind === "discard_candidate")
      return candidate.kind === "production"
        ? {
            kind: "valid",
            value: {
              schemaVersion: 1,
              kind: "discard_candidate",
              target,
              candidate,
            },
          }
        : invalidCommand(
            "Only a production or rehearsal candidate can be discarded.",
          );
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "accept_candidate",
        target,
        candidate,
      },
    };
  }
  if (raw.kind === "prepare_layout" && raw.schemaVersion === 2) {
    const target = parseSurfaceReference(raw.target);
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "operationId",
        "baseModelHash",
        "xMm",
        "yMm",
      ]) ||
      target === null ||
      !identifier(raw.operationId) ||
      typeof raw.baseModelHash !== "string" ||
      !SHA256_PATTERN.test(raw.baseModelHash) ||
      !layoutOffset(raw.xMm) ||
      !layoutOffset(raw.yMm)
    )
      return invalidCommand(
        "Rack placement requires a tray, a model hash and whole X/Y offsets within ±600 mm.",
      );
    return {
      kind: "valid",
      value: {
        schemaVersion: 2,
        kind: "prepare_layout",
        target,
        operationId: raw.operationId,
        baseModelHash: raw.baseModelHash,
        xMm: raw.xMm,
        yMm: raw.yMm,
      },
    };
  }
  if (raw.kind === "prepare_layout") {
    const target = parseSurfaceReference(raw.target);
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "baseModelHash",
        "xMm",
        "yMm",
      ]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      typeof raw.baseModelHash !== "string" ||
      !SHA256_PATTERN.test(raw.baseModelHash) ||
      !layoutOffset(raw.xMm) ||
      !layoutOffset(raw.yMm)
    )
      return invalidCommand(
        "Rack placement requires a model hash and whole X/Y offsets within ±600 mm.",
      );
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "prepare_layout",
        target,
        baseModelHash: raw.baseModelHash,
        xMm: raw.xMm,
        yMm: raw.yMm,
      },
    };
  }
  if (raw.kind === "prepare_production_control") {
    const target = parseSurfaceReference(raw.target);
    const production = parseBakeryProductionTarget(raw.production);
    const control = parseBakeryProductionControl(raw.control);
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "production",
        "control",
      ]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      production === null ||
      control === null
    )
      return invalidCommand("The persistent production control is invalid.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "prepare_production_control",
        target,
        production,
        control,
      },
    };
  }
  if (raw.kind === "prepare_edit") {
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "baseDraft",
        "edits",
      ])
    )
      return invalidCommand("The Kitchen edit proposal is invalid.");
    const target = parseSurfaceReference(raw.target);
    const baseDraft = parseDraftReference(raw.baseDraft);
    const edits = parseEditOperations(raw.edits);
    if (
      raw.schemaVersion !== 1 ||
      target === null ||
      baseDraft === null ||
      edits === null
    )
      return invalidCommand("The Kitchen edit proposal is invalid.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "prepare_edit",
        target,
        baseDraft,
        edits,
      },
    };
  }
  if (raw.kind === "select_item") {
    const target = parseSurfaceReference(raw.target);
    const selection = parseSelectionTarget(raw.selection);
    if (
      !hasExactKeys(raw, ["schemaVersion", "kind", "target", "selection"]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      selection === null ||
      selection.kind === "operation"
    )
      return invalidCommand("The Kitchen selection is invalid.");
    return {
      kind: "valid",
      value: { schemaVersion: 1, kind: "select_item", target, selection },
    };
  }
  if (raw.kind === "rotate_equipment") {
    const target = parseSurfaceReference(raw.target);
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "applianceId",
        "rotationDegrees",
      ]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      !identifier(raw.applianceId) ||
      !rotationDegrees(raw.rotationDegrees)
    )
      return invalidCommand("The Kitchen equipment rotation is invalid.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "rotate_equipment",
        target,
        applianceId: raw.applianceId,
        rotationDegrees: raw.rotationDegrees,
      },
    };
  }
  if (raw.kind === "move_equipment") {
    const target = parseSurfaceReference(raw.target);
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "applianceId",
        "xMm",
        "zMm",
      ]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      !identifier(raw.applianceId) ||
      !floorPlanCoordinateMm(raw.xMm) ||
      !floorPlanCoordinateMm(raw.zMm)
    )
      return invalidCommand("The Kitchen equipment move is invalid.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "move_equipment",
        target,
        applianceId: raw.applianceId,
        xMm: raw.xMm,
        zMm: raw.zMm,
      },
    };
  }
  if (raw.kind === "toggle_opening") {
    const target = parseSurfaceReference(raw.target);
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "openingId",
        "open",
      ]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      !identifier(raw.openingId) ||
      typeof raw.open !== "boolean"
    )
      return invalidCommand("The Kitchen opening toggle is invalid.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "toggle_opening",
        target,
        openingId: raw.openingId,
        open: raw.open,
      },
    };
  }
  if (raw.kind === "select_floor_plan") {
    const target = parseSurfaceReference(raw.target);
    if (
      !hasExactKeys(raw, ["schemaVersion", "kind", "target", "floorPlan"]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      !floorPlanId(raw.floorPlan)
    )
      return invalidCommand(
        "The Kitchen floor plan selection is invalid.",
      );
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "select_floor_plan",
        target,
        floorPlan: raw.floorPlan,
      },
    };
  }
  if (raw.kind === "set_equipment_angle") {
    const target = parseSurfaceReference(raw.target);
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "applianceId",
        "yawDegrees",
      ]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      !identifier(raw.applianceId) ||
      !rotationDegrees(raw.yawDegrees)
    )
      return invalidCommand(
        "The Kitchen equipment angle is invalid.",
      );
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "set_equipment_angle",
        target,
        applianceId: raw.applianceId,
        yawDegrees: raw.yawDegrees,
      },
    };
  }
  if (raw.kind === "configure_interior") {
    const target = parseSurfaceReference(raw.target);
    const action = parseBakeryStoreInteriorAction(raw.action);
    if (
      !hasExactKeys(raw, ["schemaVersion", "kind", "target", "action"]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      action === null
    )
      return invalidCommand(
        "The Kitchen store interior action is invalid.",
      );
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "configure_interior",
        target,
        action,
      },
    };
  }
  if (raw.kind === "reset_floor_plan") {
    const target = parseSurfaceReference(raw.target);
    if (
      !hasExactKeys(raw, ["schemaVersion", "kind", "target", "action"]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      !isBakeryFloorPlanResetAction(raw.action)
    )
      return invalidCommand(
        "The Kitchen floor plan reset action is invalid.",
      );
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "reset_floor_plan",
        target,
        action: raw.action,
      },
    };
  }
  if (raw.kind === "start_production") {
    const target = parseSurfaceReference(raw.target);
    if (
      !hasExactKeys(raw, ["schemaVersion", "kind", "target", "preset"]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      (raw.preset !== "procedure" && raw.preset !== "one-batch")
    )
      return invalidCommand("The Kitchen production start is invalid.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "start_production",
        target,
        preset: raw.preset,
      },
    };
  }
  if (raw.kind === "compare_shift") {
    const target = parseSurfaceReference(raw.target);
    if (
      !hasExactKeys(raw, ["schemaVersion", "kind", "target", "mode"]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      (raw.mode !== "normal" && raw.mode !== "outage")
    )
      return invalidCommand("The Kitchen shift comparison is invalid.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "compare_shift",
        target,
        mode: raw.mode,
      },
    };
  }
  if (raw.kind === "run_shift") {
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "baseDraft",
        "edits",
      ])
    )
      return invalidCommand("The Kitchen shift run is invalid.");
    const target = parseSurfaceReference(raw.target);
    const baseDraft = parseDraftReference(raw.baseDraft);
    const edits =
      Array.isArray(raw.edits) && raw.edits.length === 0
        ? []
        : parseEditOperations(raw.edits);
    if (
      raw.schemaVersion !== 1 ||
      target === null ||
      baseDraft === null ||
      edits === null
    )
      return invalidCommand("The Kitchen shift run is invalid.");
    return {
      kind: "valid",
      value: { schemaVersion: 1, kind: "run_shift", target, baseDraft, edits },
    };
  }
  if (raw.kind === "prepare_run_save") {
    if (!hasExactKeys(raw, ["schemaVersion", "kind", "target", "name"]))
      return invalidCommand("The Kitchen run-save proposal is invalid.");
    const target = parseSurfaceReference(raw.target);
    if (
      raw.schemaVersion !== 1 ||
      target === null ||
      typeof raw.name !== "string" ||
      raw.name.trim().length === 0 ||
      raw.name.length > 80
    )
      return invalidCommand("The Kitchen run-save proposal is invalid.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "prepare_run_save",
        target,
        name: raw.name.trim(),
      },
    };
  }
  if (raw.kind === "prepare_scenario_save") {
    if (!hasExactKeys(raw, ["schemaVersion", "kind", "target", "name", "note"]))
      return invalidCommand(
        "The Kitchen scenario-save proposal is invalid.",
      );
    const target = parseSurfaceReference(raw.target);
    if (
      raw.schemaVersion !== 1 ||
      target === null ||
      typeof raw.name !== "string" ||
      raw.name.trim().length === 0 ||
      raw.name.length > 80 ||
      typeof raw.note !== "string" ||
      raw.note.trim().length === 0 ||
      raw.note.length > 2000
    )
      return invalidCommand(
        "The Kitchen scenario-save proposal is invalid.",
      );
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "prepare_scenario_save",
        target,
        name: raw.name.trim(),
        note: raw.note.trim(),
      },
    };
  }
  if (raw.kind === "apply_reviewed_edit") {
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "baseDraft",
        "proposalDigest",
      ])
    )
      return invalidCommand("The reviewed Kitchen edit is invalid.");
    const target = parseSurfaceReference(raw.target);
    const baseDraft = parseDraftReference(raw.baseDraft);
    if (
      raw.schemaVersion !== 1 ||
      target === null ||
      baseDraft === null ||
      typeof raw.proposalDigest !== "string" ||
      !SHA256_PATTERN.test(raw.proposalDigest)
    )
      return invalidCommand("The reviewed Kitchen edit is invalid.");
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "apply_reviewed_edit",
        target,
        baseDraft,
        proposalDigest: raw.proposalDigest,
      },
    };
  }
  if (raw.kind === "edit_rehearsal") {
    const target = parseSurfaceReference(raw.target);
    const edit = parseRehearsalEdit(raw.edit);
    if (
      !hasExactKeys(raw, [
        "schemaVersion",
        "kind",
        "target",
        "planFingerprint",
        "edit",
      ]) ||
      raw.schemaVersion !== 1 ||
      target === null ||
      !identifier(raw.planFingerprint) ||
      edit === null
    )
      return invalidCommand(
        "A rehearsal edit names its plan and one tray chain, baker, start or prerequisite change.",
      );
    return {
      kind: "valid",
      value: {
        schemaVersion: 1,
        kind: "edit_rehearsal",
        target,
        planFingerprint: raw.planFingerprint,
        edit,
      },
    };
  }
  if (
    raw.kind === "edit_production" ||
    raw.kind === "preview_production" ||
    raw.kind === "apply_production"
  )
    return parseProductionCommand(raw, raw.kind);
  return invalidCommand("The Kitchen surface command is unsupported.");
}

function parseProductionCommand(
  raw: Readonly<Record<string, unknown>>,
  kind: "edit_production" | "preview_production" | "apply_production",
): BakerySurfaceCommandParseResult {
  const target = parseSurfaceReference(raw.target);
  const keys = ["schemaVersion", "kind", "target", "draftDigest"];
  if (
    !hasExactKeys(
      raw,
      kind === "edit_production"
        ? [...keys, "edit"]
        : kind === "apply_production"
          ? [...keys, "planFingerprint"]
          : keys,
    ) ||
    raw.schemaVersion !== 1 ||
    target === null ||
    typeof raw.draftDigest !== "string" ||
    !SHA256_PATTERN.test(raw.draftDigest)
  )
    return invalidCommand(
      "A production command names the draft it was prepared against.",
    );
  const draftDigest = raw.draftDigest;
  if (kind === "preview_production")
    return {
      kind: "valid",
      value: { schemaVersion: 1, kind, target, draftDigest },
    };
  if (kind === "apply_production")
    return identifier(raw.planFingerprint)
      ? {
          kind: "valid",
          value: {
            schemaVersion: 1,
            kind,
            target,
            draftDigest,
            planFingerprint: raw.planFingerprint,
          },
        }
      : invalidCommand("A production apply names the previewed plan.");
  const edit = parseProductionEdit(raw.edit);
  return edit === null
    ? invalidCommand(
        "A production edit changes one tray, manual task or the oven variant, or discards the draft.",
      )
    : {
        kind: "valid",
        value: { schemaVersion: 1, kind, target, draftDigest, edit },
      };
}

function parseProductionEdit(raw: unknown): BakeryProductionEdit | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "prepare_replacement":
      return hasExactKeys(raw, ["kind", "source"]) &&
        (raw.source === "preview" ||
          raw.source === "procedure" ||
          raw.source === "one-batch")
        ? { kind: "prepare_replacement", source: raw.source }
        : null;
    case "assign_tray":
    case "unassign_tray":
      return hasExactKeys(raw, ["kind", "batchId", "tray"]) &&
        identifier(raw.batchId) &&
        smallCount(raw.tray)
        ? { kind: raw.kind, batchId: raw.batchId, tray: raw.tray }
        : null;
    case "set_baker":
      return hasExactKeys(raw, ["kind", "batchId", "tray", "baker"]) &&
        identifier(raw.batchId) &&
        smallCount(raw.tray) &&
        baker(raw.baker)
        ? {
            kind: "set_baker",
            batchId: raw.batchId,
            tray: raw.tray,
            baker: raw.baker,
          }
        : null;
    case "set_prerequisites": {
      const dependsOn = taskLinks(raw.dependsOn);
      return hasExactKeys(raw, ["kind", "batchId", "tray", "dependsOn"]) &&
        identifier(raw.batchId) &&
        smallCount(raw.tray) &&
        dependsOn !== null
        ? {
            kind: "set_prerequisites",
            batchId: raw.batchId,
            tray: raw.tray,
            dependsOn,
          }
        : null;
    }
    case "set_start":
      return hasExactKeys(raw, [
        "kind",
        "batchId",
        "tray",
        "earliestStartSeconds",
      ]) &&
        identifier(raw.batchId) &&
        smallCount(raw.tray) &&
        wholeSeconds(raw.earliestStartSeconds)
        ? {
            kind: "set_start",
            batchId: raw.batchId,
            tray: raw.tray,
            earliestStartSeconds: raw.earliestStartSeconds,
          }
        : null;
    case "set_manual_task": {
      const task = parseManualTask(raw, true);
      return task === null ? null : { kind: "set_manual_task", ...task };
    }
    case "set_variant":
      return hasExactKeys(raw, ["kind", "variant"]) &&
        (raw.variant === "normal" || raw.variant === "outage")
        ? { kind: "set_variant", variant: raw.variant }
        : null;
    case "discard_draft":
      return hasExactKeys(raw, ["kind"]) ? { kind: "discard_draft" } : null;
    default:
      return null;
  }
}

export function isRehearsalChange(
  edit: BakeryRehearsalEdit,
): edit is BakeryRehearsalChange {
  return (
    edit.kind === "add_human_transfer" ||
    edit.kind === "set_cell" ||
    edit.kind === "set_ingredients" ||
    edit.kind === "replace_preset" ||
    edit.kind === "clear_results" ||
    edit.kind === "remove_tray"
  );
}

function parseRehearsalEdit(raw: unknown): BakeryRehearsalEdit | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "add_human_transfer":
    case "set_ingredients":
    case "set_cell":
    case "replace_preset":
    case "clear_results":
    case "remove_tray":
      return parseRehearsalChange(raw);
    case "set_faults": {
      if (!hasExactKeys(raw, ["kind", "faults"])) return null;
      const faults = parseRehearsalFaults(raw.faults);
      return faults === null ? null : { kind: "set_faults", faults };
    }
    case "add_tray_chain":
      return hasExactKeys(raw, ["kind", "rackCase"]) &&
        (raw.rackCase === "nominal" || raw.rackCase === "slip")
        ? { kind: "add_tray_chain", rackCase: raw.rackCase }
        : null;
    case "set_baker":
      return hasExactKeys(raw, ["kind", "batchId", "baker"]) &&
        identifier(raw.batchId) &&
        baker(raw.baker)
        ? { kind: "set_baker", batchId: raw.batchId, baker: raw.baker }
        : null;
    case "set_start":
      return hasExactKeys(raw, [
        "kind",
        "operationId",
        "earliestStartSeconds",
      ]) &&
        identifier(raw.operationId) &&
        wholeSeconds(raw.earliestStartSeconds)
        ? {
            kind: "set_start",
            operationId: raw.operationId,
            earliestStartSeconds: raw.earliestStartSeconds,
          }
        : null;
    case "set_prerequisites": {
      if (
        !hasExactKeys(raw, ["kind", "batchId", "dependsOn"]) ||
        !identifier(raw.batchId) ||
        !Array.isArray(raw.dependsOn) ||
        raw.dependsOn.length > MAX_SUMMARIES * 3 ||
        !raw.dependsOn.every(identifier) ||
        new Set(raw.dependsOn).size !== raw.dependsOn.length
      )
        return null;
      return {
        kind: "set_prerequisites",
        batchId: raw.batchId,
        dependsOn: [...raw.dependsOn],
      };
    }
    default:
      return null;
  }
}

export function parseBakeryFileAction(raw: unknown): BakeryFileAction | null {
  if (!isRecord(raw)) return null;
  if (
    raw.kind === "import" &&
    hasExactKeys(raw, ["kind", "digest"]) &&
    typeof raw.digest === "string" &&
    SHA256_PATTERN.test(raw.digest)
  )
    return { kind: "import", digest: raw.digest };
  if (
    raw.kind === "export" &&
    hasExactKeys(raw, ["kind", "format"]) &&
    (raw.format === "run" ||
      raw.format === "request" ||
      raw.format === "recording" ||
      raw.format === "handoff")
  )
    return { kind: "export", format: raw.format };
  return null;
}
