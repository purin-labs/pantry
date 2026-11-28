import {
  prepareProductionFile,
  exportProductionFile,
} from "./production-files.ts";
import { prepareProductionNavigation } from "./production-navigation.ts";
import { prepareProductionReplacement } from "./production-draft.ts";
import { isRehearsalChange } from "@purin-labs/bakery-model/bakery-surface";
import { prepareRehearsalReview } from "./rehearsal-edits.ts";
import { parseRunFaults } from "@purin-labs/production-simulation/recipes/bakery/run-faults";
import { applyPlaybackAction } from "./playback-actions.ts";
import { prepareWorkcell } from "./workcell-preparation.ts";
import { prepareRackLayout, evaluateRackLayout } from "./rack-layout.ts";
import {
  acceptProductionCandidate,
  layoutTray,
  selectedTray,
} from "./scheduled-rehearsal.ts";
import {
  exportRehearsalWorkcells,
  type ProductionWorkcells,
  type RehearsalEdit,
} from "@purin-labs/production-simulation/recipes/bakery/production-workcells";
import type { ProductionSession } from "./production-session.ts";
import {
  editProductionDraft,
  prepareProductionPreview,
  productionDraftSource,
  type ProductionDraftEdit,
} from "./production-draft.ts";
import { productionAssignmentId } from "@purin-labs/bakery-model/bakery-production-scenario";
import { prepareRehearsalEdit, trayChainEdit } from "./rehearsal-edits.ts";
import type {
  RejectedBakerySurfaceCommandResultV1,
  BakerySurfaceCommandV1,
  BakerySurfaceDraftReference,
  BakerySurfaceEditOperation,
  BakerySurfaceShiftLayout,
  BakerySurfaceEditProposalV1,
  BakeryRehearsalEdit,
  BakeryProductionEdit,
  BakerySurfaceTaskDetail,
} from "@purin-labs/bakery-model/bakery-surface";
import { resolveRecordingAcceptanceReference } from "./recording-acceptance.ts";
import {
  prepareRecordingNavigation,
  recordingHasDoor,
} from "@purin-labs/production-simulation/simulator/playback-state";
import {
  fields,
  parseSettings,
  type Settings,
  type SettingsField,
} from "@purin-labs/bakery-model/bakery";
import { parseProcedureAssumptions } from "@purin-labs/bakery-model/bakery-procedure";
import { simulate } from "@purin-labs/production-simulation/recipes/bakery/schedule";
import {
  activeRun,
  canReviewRehearsal,
  normalRun,
  canReplaceProduction,
  simulatorShellView,
  type SimulatorState,
} from "./simulator-state.ts";
import {
  runShiftInputs,
  shiftInputEditable,
  SHIFT_RUN_NOTICE,
} from "./shift-run.ts";
import {
  readWorkspaceRuns,
  prepareRehearsalRunWorkspace,
  openRehearsalRunWorkspace,
  openProductionWorkspaceRun,
} from "./workspace-runs-api.ts";
import { rehearsalSettings } from "@purin-labs/production-simulation/simulator/rehearsal-presets";
import { prepareWorkspaceRunReview } from "./workspace-run-review.ts";
import { canOpenWorkspaceRun, shiftProcedure } from "./simulator-state.ts";
import { bakeryFingerprint } from "@purin-labs/bakery-model/bakery";
import { parseScenarioCopy } from "@purin-labs/bakery-model/bakery-scenario";
import {
  parseProductionScenario,
  productionDefinitionFingerprint,
} from "@purin-labs/bakery-model/bakery-production-scenario";
import {
  agentScenarioSaveManifest,
  type AgentScenarioSavePayload,
} from "@purin-labs/bakery-model/bakery-agent-scenario-save";
import type { Variant } from "@purin-labs/type-utils";
import { canonicalJson, sha256Hex } from "@purin-labs/std";
import type {
  BakeryWorkspaceRead,
  PreparedBakerySurfaceCommand,
  SurfaceDigest,
} from "./bakery-surface-command-types.ts";
import {
  applicablePreview,
  authorableProduction,
  bakerySurfaceDraftMaterial,
  bakerySurfaceDraftReference,
  comparisonSource,
  hasId,
  inspectScenarioSave,
  inspectWorkspaceRunSave,
  normalSettings,
  productionComparison,
  productionDraftMaterial,
  rehearsalEditable,
  rehearsalSaveSource,
  rejectedCommand,
  reviewablePreview,
  runPreview,
  sameSettings,
  scheduledSession,
  shiftLayout,
  shiftSelection,
  shiftTaskDetail,
  simulationMatches,
} from "./bakery-surface-reads.ts";

export async function prepareBakerySurfaceCommand(
  state: SimulatorState,
  command: BakerySurfaceCommandV1,
  digest: SurfaceDigest = sha256Hex,
  workspace: BakeryWorkspaceRead | null = null,
): Promise<
  PreparedBakerySurfaceCommand | RejectedBakerySurfaceCommandResultV1
> {
  const stale = staleSurface(state, command);
  if (stale !== null) return stale;
  if (command.kind === "file_action") {
    if (
      workspace === null ||
      state.workspace.kind !== "production" ||
      !canOpenWorkspaceRun(state)
    )
      return rejectedCommand(
        command.kind,
        "unsupported_command",
        "Prepare a connected run and resolve pending work before using files.",
      );
    const source = state.workspace.production;
    try {
      const file =
        command.action.kind === "import"
          ? workspace.readAttachment(command.action.digest)
          : exportProductionFile(source, command.action.format);
      const manifest = {
        name: file.name,
        digest: await sha256Hex(file.text),
        bytes: new TextEncoder().encode(file.text).length,
      };
      if (
        command.action.kind === "import" &&
        manifest.digest !== command.action.digest
      )
        throw new Error("The attached file changed. Attach it again.");
      const prepared =
        command.action.kind === "import"
          ? {
              kind: "import" as const,
              pending: await prepareProductionFile(
                source,
                normalRun(state).settings,
                file.text,
                {
                  kind: "connected",
                  organisationId: workspace.organisationId,
                  readDefinition: workspace.readDefinition,
                },
                "nominal",
              ),
            }
          : { kind: "export" as const, file };
      return { kind: "file", command, source, manifest, prepared };
    } catch (error) {
      return rejectedCommand(
        command.kind,
        "unsupported_command",
        error instanceof Error
          ? error.message
          : "The file could not be prepared.",
      );
    }
  }
  if (command.kind === "inspect_scenario_save") {
    if (workspace === null)
      return rejectedCommand(
        command.kind,
        "unsupported_command",
        "Connect a workspace to inspect its scenario save.",
      );
    const source = state.workspace.scenarioSaveProposal;
    const inspection = await inspectScenarioSave(workspace, source);
    return { kind: "scenario_inspection", command, source, inspection };
  }
  if (command.kind === "inspect_run_save") {
    if (workspace === null || state.workspace.kind !== "production")
      return rejectedCommand(
        command.kind,
        "unsupported_command",
        "Open a connected production or rehearsal workspace to inspect its save.",
      );
    const source = state.workspace.runSaves[command.runKind];
    const inspection = await inspectWorkspaceRunSave(
      workspace,
      command.runKind,
      source,
    );
    return { kind: "save_inspection", command, source, inspection };
  }
  if (command.kind === "list_saved_runs") {
    if (workspace === null || state.workspace.kind !== "production")
      return rejectedCommand(
        command.kind,
        "unsupported_command",
        "Open a connected production or rehearsal workspace to list saved runs.",
      );
    try {
      const page = await readWorkspaceRuns(
        workspace.organisationId,
        command.runKind,
        command.cursor,
        workspace.read,
      );
      return { kind: "saved_runs", command, page };
    } catch (error) {
      return rejectedCommand(
        command.kind,
        "target_not_found",
        error instanceof Error ? error.message : "Unable to read saved runs.",
      );
    }
  }
  if (command.kind === "prepare_run_open") {
    if (
      workspace === null ||
      !canOpenWorkspaceRun(state) ||
      state.workspace.kind !== "production" ||
      state.workspace.production.data.kind !== "ready" ||
      state.workspace.production.pending.kind !== "none" ||
      command.runKind !==
        (state.workspace.production.procedure === "rehearsal"
          ? "rehearsal"
          : "production")
    )
      return rejectedCommand(
        command.kind,
        "unsupported_command",
        "Open the matching workspace and resolve pending work before reviewing a saved run.",
      );
    const session = state.workspace.production;
    const from = state.workspace.production.data;
    try {
      const saved =
        command.runKind === "rehearsal"
          ? await openRehearsalRunWorkspace(
              workspace.organisationId,
              command.id,
              workspace.read,
              rehearsalSettings(from.plan.settings),
            )
          : await openProductionWorkspaceRun(
              workspace.organisationId,
              command.id,
              workspace.read,
              workspace.readDefinition,
            );
      const review = prepareWorkspaceRunReview({
        from,
        draft: productionDraftSource(session),
        preview: session.preview,
        name: session.draftName,
        note: session.draftNote,
        presentation: session.presentation,
        plan: saved.plan,
        procedure: "procedure" in saved ? saved.procedure : null,
        notes: "notes" in saved ? saved.notes : [],
        readOnly: "readOnly" in saved ? saved.readOnly : [],
        savedRun: saved.savedRun,
      });
      return { kind: "run_open", command, review };
    } catch (error) {
      return rejectedCommand(
        command.kind,
        "target_not_found",
        error instanceof Error
          ? error.message
          : "The exact saved run could not be read. Your current run is unchanged.",
      );
    }
  }
  if (command.kind === "prepare_workcell") {
    try {
      const result = await prepareWorkcell(state, command.preparation);
      return result.kind === "invalid"
        ? rejectedCommand(command.kind, "unsupported_command", result.message)
        : {
            kind: "workcell_preparation",
            command,
            prepared: result.prepared,
          };
    } catch {
      return rejectedCommand(
        command.kind,
        "unsupported_command",
        "The workcell source could not be loaded. The current workspace is unchanged.",
      );
    }
  }
  if (command.kind === "stop_simulation")
    return simulationMatches(state, command)
      ? { kind: "simulation_stop", command }
      : rejectedCommand(
          command.kind,
          "stale_surface",
          "The attached simulation is no longer running.",
        );
  if (command.kind === "control_workspace_view") {
    if (command.action.kind === "setDoorPreview") {
      if (
        state.workspace.kind !== "rehearsal" ||
        state.replay.kind !== "recording" ||
        !recordingHasDoor(state.replay.recording)
      )
        return rejectedCommand(
          command.kind,
          "unsupported_command",
          "Door preview requires an oven recording with verified hinge geometry.",
        );
      return { kind: "workspace_view", command };
    }
    const cameraAction =
      command.action.kind === "setCamera" ||
      command.action.kind === "resetCamera";
    if (state.workspace.kind !== "shift" && !cameraAction)
      return rejectedCommand(
        command.kind,
        "unsupported_command",
        "This view supports camera and recenter controls. Other view controls belong to Shift.",
      );
    if (
      command.action.kind === "setCamera" &&
      command.action.camera !== "perspective" &&
      command.action.camera !== "overhead" &&
      (state.workspace.kind !== "rehearsal" ||
        state.replay.kind !== "recording")
    )
      return rejectedCommand(
        command.kind,
        "unsupported_command",
        "Cell, task, selection and operator-height cameras are available in the recording viewer.",
      );
    return { kind: "workspace_view", command };
  }
  if (command.kind === "show_production_panel") {
    if (
      state.workspace.kind !== "production" ||
      state.workspace.production.data.kind !== "ready"
    )
      return rejectedCommand(
        command.kind,
        "unsupported_command",
        "Open a production run or rehearsal before selecting a panel.",
      );
    return {
      kind: "production_panel",
      command,
      from: state.workspace.production.data,
    };
  }
  if (command.kind === "control_baseline") {
    const source = comparisonSource(state);
    const comparison = await productionComparison(state);
    if (
      source === null ||
      comparison === null ||
      canonicalJson(comparison) !== canonicalJson(command.comparison) ||
      state.workspace.kind !== "production"
    )
      return rejectedCommand(
        command.kind,
        "stale_surface",
        "The displayed run or its baseline changed. Inspect it again before pinning or clearing.",
      );
    return {
      kind: "baseline",
      command,
      source,
      baseline: state.workspace.production.baseline,
    };
  }
  if (command.kind === "control_playback") {
    const result = applyPlaybackAction(command.action, state);
    return result.kind === "unavailable"
      ? rejectedCommand(command.kind, "unsupported_command", result.message)
      : { kind: "playback", command };
  }
  const scheduled = scheduledSession(state);
  if (command.kind === "set_view" && state.workspace.kind === "rehearsal") {
    const document = simulatorShellView(state).recording.document;
    const navigation =
      document.kind === "ready"
        ? prepareRecordingNavigation(document, command.view)
        : null;
    return navigation === null
      ? rejectedCommand(
          command.kind,
          "target_not_found",
          "The selected transfer, resource or time is absent from the loaded recording.",
        )
      : { kind: "recording_view", command, navigation };
  }
  if (command.kind === "set_view" && state.workspace.kind === "production") {
    const data = state.workspace.production.data;
    const navigation =
      data.kind === "ready" && !state.workspace.production.reading
        ? prepareProductionNavigation(data, command.view)
        : null;
    if (navigation === null)
      return rejectedCommand(
        command.kind,
        "target_not_found",
        "The selected identity or time is absent from the applied run.",
      );
    return { kind: "production_view", command, navigation };
  }
  if (command.kind === "prepare_layout" && scheduled !== null) {
    const tray = layoutTray(scheduled.data.plan, selectedTray(scheduled));
    if (
      command.schemaVersion !== 2 ||
      tray === null ||
      tray.id !== command.operationId ||
      tray.attempt.input.request.modelHash !== command.baseModelHash
    )
      return rejectedCommand(
        command.kind,
        "stale_surface",
        "The rehearsal tray's layout changed or is unavailable.",
      );
    try {
      const draft = evaluateRackLayout(
        tray.attempt,
        state.workspace.surfaceEpoch,
        command.xMm,
        command.yMm,
      );
      if (draft.kind === "invalid")
        return rejectedCommand(command.kind, "invalid_edit", draft.message);
      return {
        kind: "tray_layout",
        command,
        baseLayout: scheduled.layout,
        operationId: tray.id,
        proposal: await prepareRackLayout(draft),
      };
    } catch (error) {
      return rejectedCommand(
        command.kind,
        "invalid_edit",
        error instanceof Error ? error.message : "Invalid rack placement.",
      );
    }
  }
  if (command.kind === "prepare_layout")
    return rejectedCommand(
      command.kind,
      "stale_surface",
      "Select a rehearsal tray whose rack can move before preparing a layout.",
    );
  if (command.kind === "edit_rehearsal")
    return prepareRehearsalCommand(state, command);
  if (
    command.kind === "edit_production" ||
    command.kind === "preview_production" ||
    command.kind === "apply_production"
  )
    return prepareProductionCommand(state, command, digest);
  if (command.kind === "simulate_workcell")
    return rejectedCommand(
      command.kind,
      "unsupported_command",
      "Browser physics execution requires the mounted simulator.",
    );
  if (command.kind === "inspect_surface")
    return {
      kind: "read",
      command,
      draftMaterial: null,
      draft: null,
      tasks: null,
    };
  if (
    command.kind === "accept_candidate" ||
    command.kind === "discard_candidate"
  ) {
    const target = await resolveRecordingAcceptanceReference(
      state,
      command.candidate,
    );
    if (target === null)
      return rejectedCommand(
        command.kind,
        "stale_surface",
        "The recording candidate changed before acceptance.",
      );
    if (command.kind === "discard_candidate")
      return { kind: "discard", command, target };
    if (
      target.kind === "production" &&
      state.workspace.kind === "production" &&
      state.workspace.production.data.kind === "ready"
    ) {
      const from = state.workspace.production.data.plan;
      const accepted = await acceptProductionCandidate(from, target.candidate);
      if (accepted.kind === "rejected")
        return rejectedCommand(command.kind, "stale_surface", accepted.message);
      return {
        kind: "accept",
        command,
        target: { ...target, accepted: { from, plan: accepted.plan } },
      };
    }
    return rejectedCommand(
      command.kind,
      "stale_surface",
      "The production workspace changed before acceptance.",
    );
  }
  if (command.kind === "prepare_run_save") {
    const source = rehearsalSaveSource(state);
    if (source === null)
      return rejectedCommand(
        command.kind,
        "unsupported_command",
        "Prepare a rehearsal run before proposing a save.",
      );
    const status = state.workspace.runSaves.rehearsal;
    if (
      status.kind === "saving" ||
      status.kind === "outcome-unknown" ||
      status.kind === "saved-readback-failed"
    )
      return rejectedCommand(
        command.kind,
        "unsupported_command",
        "Resolve the previous save before preparing another copy.",
      );
    try {
      const prepared = await prepareRehearsalRunWorkspace(command.name, source);
      if (
        status.kind === "not-found" &&
        (status.id !== prepared.id || status.name !== prepared.snapshot.name)
      )
        return rejectedCommand(
          command.kind,
          "unsupported_command",
          "Retry only the reviewed copy whose exact ID was confirmed missing.",
        );
      return {
        kind: "run_save",
        command,
        prepared,
        sourceFile: exportRehearsalWorkcells(source),
      };
    } catch (error) {
      return rejectedCommand(
        command.kind,
        "unsupported_command",
        error instanceof Error ? error.message : "This run cannot be saved.",
      );
    }
  }
  if (command.kind === "prepare_scenario_save")
    return prepareScenarioSave(state, command);
  if (state.workspace.kind !== "shift")
    return rejectedCommand(
      command.kind,
      "unsupported_command",
      "This Kitchen workspace does not support that command yet.",
    );
  if (command.kind === "read_draft") {
    const draft = await bakerySurfaceDraftSnapshot(state, digest);
    return draft.kind === "rejected"
      ? draft
      : {
          kind: "read",
          command,
          draftMaterial: bakerySurfaceDraftMaterial(state),
          draft: draft.value,
          tasks: null,
        };
  }
  if (command.kind === "query_tasks")
    return {
      kind: "read",
      command,
      draftMaterial: null,
      draft: null,
      tasks: queryShiftTasks(state, command.filter),
    };
  if (command.kind === "run_shift")
    return prepareShiftRun(state, command, digest);
  if (command.kind === "select_item") {
    const selection = shiftSelection(activeRun(state), command.selection);
    return selection === null
      ? rejectedCommand(
          command.kind,
          "target_not_found",
          "That batch, worker, station or task is not in the displayed run.",
        )
      : { kind: "shift_view", command, selection };
  }
  if (command.kind === "compare_shift")
    return { kind: "shift_view", command, selection: null };
  if (command.kind === "start_production")
    return state.procedureLoad.kind === "loading"
      ? rejectedCommand(
          command.kind,
          "unsupported_command",
          "The recipe is still loading. Open production after it loads.",
        )
      : { kind: "production_start", command };
  if (command.kind === "rotate_equipment") {
    const layout = shiftLayout();
    const rejected = equipmentRotationRejected(command, layout);
    return (
      rejected ?? {
        kind: "equipment_rotation",
        command,
        floorPlan: layout?.floorPlan ?? "",
      }
    );
  }
  if (command.kind === "move_equipment") {
    const layout = shiftLayout();
    const rejected = equipmentMoveRejected(command, layout);
    return (
      rejected ?? {
        kind: "equipment_move",
        command,
        floorPlan: layout?.floorPlan ?? "",
      }
    );
  }
  if (command.kind === "toggle_opening") {
    const layout = shiftLayout();
    const rejected = openingToggleRejected(command, layout);
    return (
      rejected ?? {
        kind: "opening_toggle",
        command,
        floorPlan: layout?.floorPlan ?? "",
      }
    );
  }
  if (command.kind === "select_floor_plan") {
    const layout = shiftLayout();
    return layout === null
      ? rejectedCommand(
          command.kind,
          "unsupported_command",
          "The floor plan is not open.",
        )
      : { kind: "floor_plan_select", command };
  }
  if (command.kind === "set_equipment_angle") {
    const layout = shiftLayout();
    const rejected = equipmentAngleRejected(command, layout);
    return (
      rejected ?? {
        kind: "equipment_angle",
        command,
        floorPlan: layout?.floorPlan ?? "",
      }
    );
  }
  if (command.kind === "configure_interior") {
    const layout = shiftLayout();
    return layout === null
      ? rejectedCommand(
          command.kind,
          "unsupported_command",
          "The floor plan is not open.",
        )
      : { kind: "interior_configure", command };
  }
  if (command.kind === "reset_floor_plan") {
    const layout = shiftLayout();
    const rejected = floorPlanResetRejected(command, layout);
    return (
      rejected ?? {
        kind: "floor_plan_reset",
        command,
        floorPlan: layout?.floorPlan ?? "",
      }
    );
  }
  if (command.kind === "prepare_edit") {
    const current = await bakerySurfaceDraftReference(state, digest);
    if (!sameDraftReference(current, command.baseDraft))
      return rejectedCommand(
        command.kind,
        "stale_draft",
        "The Kitchen draft changed after this edit was prepared.",
      );
    const preview = previewSurfaceEdits(state, command.edits);
    if (preview.kind === "invalid")
      return rejectedCommand(command.kind, "invalid_edit", preview.message);
    const proposalContent = {
      baseDraft: command.baseDraft,
      edits: command.edits,
      preview: preview.value,
    };
    return {
      kind: "write",
      command,
      draftMaterial: bakerySurfaceDraftMaterial(state),
      proposal: {
        proposalDigest: await digest(JSON.stringify(proposalContent)),
        baseDraft: command.baseDraft,
        edits: command.edits,
        summary: command.edits.map(surfaceEditSummary),
        preview: preview.value,
      },
    };
  }
  if (command.kind === "apply_reviewed_edit") {
    const current = await bakerySurfaceDraftReference(state, digest);
    if (!sameDraftReference(current, command.baseDraft))
      return rejectedCommand(
        command.kind,
        "stale_draft",
        "The Kitchen draft changed before the reviewed edit was applied.",
      );
    const proposal = matchingProposal(state, command);
    if (proposal === null)
      return rejectedCommand(
        command.kind,
        "proposal_missing",
        "This reviewed Kitchen edit is no longer pending.",
      );
    const preview = previewSurfaceEdits(state, proposal.edits);
    if (preview.kind === "invalid")
      return rejectedCommand(command.kind, "invalid_edit", preview.message);
    if (JSON.stringify(preview.value) !== JSON.stringify(proposal.preview))
      return rejectedCommand(
        command.kind,
        "stale_draft",
        "The compiled preview changed after this edit was prepared.",
      );
    return {
      kind: "write",
      command,
      draftMaterial: bakerySurfaceDraftMaterial(state),
      proposal,
    };
  }
  return {
    kind: "write",
    command,
    draftMaterial: null,
    proposal: null,
  };
}

async function prepareScenarioSave(
  state: SimulatorState,
  command: Variant<BakerySurfaceCommandV1, "prepare_scenario_save">,
): Promise<
  | Variant<PreparedBakerySurfaceCommand, "scenario_save">
  | RejectedBakerySurfaceCommandResultV1
> {
  const sourceKey = scenarioSaveSourceKey(state);
  if (
    sourceKey === null ||
    state.workspace.scenarioSaveProposal.kind !== "none"
  )
    return rejectedCommand(
      command.kind,
      "unsupported_command",
      "Open an unsaved procedure or production scenario and resolve any pending save first.",
    );
  let payload: AgentScenarioSavePayload;
  if (
    state.workspace.kind === "shift" &&
    state.run.shift.kind === "procedure"
  ) {
    if (
      state.scenario.assumptionDraft.size > 0 ||
      state.procedureLoad.kind === "loading"
    )
      return rejectedCommand(
        command.kind,
        "unsupported_command",
        "Run or discard the assumption draft before saving a scenario copy.",
      );
    const procedure = state.run.shift.normal.source;
    const copy = parseScenarioCopy({
      id: state.scenario.copyId,
      name: command.name,
      note: command.note,
      procedureId: procedure.reference.entityId,
      fingerprint: await bakeryFingerprint(procedure.revisionKey),
      settings: normalRun(state).settings,
    });
    if (copy === null)
      return rejectedCommand(
        command.kind,
        "invalid_edit",
        "The scenario copy is invalid.",
      );
    payload = { kind: "scenario", copy };
  } else if (state.workspace.kind === "production") {
    const session = state.workspace.production;
    const procedure = session.sourceProcedure ?? shiftProcedure(state);
    if (
      procedure === null ||
      session.identity.kind !== "new" ||
      session.preview === null ||
      session.savingDefinition ||
      session.openingDefinition ||
      !sameSettings(procedure.settings, session.preview.plan.settings)
    )
      return rejectedCommand(
        command.kind,
        "unsupported_command",
        "Preview a valid unsaved production scenario before saving it.",
      );
    const sourceFingerprint = await bakeryFingerprint(procedure.revisionKey);
    if (
      session.sourceProcedure === null &&
      session.data.kind === "ready" &&
      session.data.plan.source.kind === "shared" &&
      (procedure.reference.entityId !==
        session.data.plan.source.definition.procedureId ||
        sourceFingerprint !==
          session.data.plan.source.definition.sourceFingerprint)
    )
      return rejectedCommand(
        command.kind,
        "stale_surface",
        "Open the production scenario source before saving edits.",
      );
    const definitionFingerprint = await productionDefinitionFingerprint(
      sourceFingerprint,
      session.preview.plan.settings,
      session.draftVariant,
      session.draft,
      session.manualTasks,
      { route: "cold-racking" },
    );
    const copy = parseProductionScenario({
      id: session.identity.id,
      name: command.name,
      note: command.note,
      procedureId: procedure.reference.entityId,
      sourceFingerprint,
      definitionFingerprint,
      settings: session.preview.plan.settings,
      variant: session.draftVariant,
      assignments: session.draft,
      manualTasks: session.manualTasks,
      presentation: session.presentation,
    });
    if (copy === null)
      return rejectedCommand(
        command.kind,
        "invalid_edit",
        "The production assignments are invalid.",
      );
    payload = { kind: "production-scenario", copy };
  } else {
    return rejectedCommand(
      command.kind,
      "unsupported_command",
      "No scenario is ready to save.",
    );
  }
  return {
    kind: "scenario_save",
    command,
    payload,
    manifest: await agentScenarioSaveManifest(payload),
    sourceKey,
  };
}

export function scenarioSaveSourceKey(state: SimulatorState): string | null {
  if (state.workspace.kind === "shift" && state.run.shift.kind === "procedure")
    return JSON.stringify({
      kind: "scenario",
      copyId: state.scenario.copyId,
      source: state.run.shift.normal.source,
      settings: normalRun(state).settings,
      draftRevision: state.scenario.draftRevision,
    });
  if (state.workspace.kind === "production") {
    const session = state.workspace.production;
    return JSON.stringify({
      kind: "production-scenario",
      identity: session.identity,
      procedure: session.sourceProcedure ?? shiftProcedure(state),
      settings: session.preview?.plan.settings,
      variant: session.draftVariant,
      assignments: session.draft,
      manualTasks: session.manualTasks,
      presentation: session.presentation,
      source: session.data.kind === "ready" ? session.data.plan.source : null,
    });
  }
  return null;
}

async function prepareRehearsalCommand(
  state: SimulatorState,
  command: Variant<BakerySurfaceCommandV1, "edit_rehearsal">,
): Promise<
  PreparedBakerySurfaceCommand | RejectedBakerySurfaceCommandResultV1
> {
  const session = scheduledSession(state);
  if (
    session === null ||
    !rehearsalEditable(state, session) ||
    session.data.plan.fingerprint !== command.planFingerprint
  )
    return rejectedCommand(
      command.kind,
      "stale_surface",
      "The rehearsal changed, is running or has a result awaiting review.",
    );
  const plan = session.data.plan;
  if (isRehearsalChange(command.edit)) {
    if (!canReviewRehearsal(state))
      return rejectedCommand(
        command.kind,
        "stale_surface",
        "Resolve pending work or save outcomes before replacing results.",
      );
    const result = await prepareRehearsalReview(plan, command.edit);
    return result.kind === "rejected"
      ? rejectedCommand(command.kind, "invalid_edit", result.message)
      : { kind: "rehearsal_review", command, review: result.review };
  }
  let edit: RehearsalEdit;
  try {
    edit = await rehearsalEdit(plan, command.edit);
  } catch (error) {
    return rejectedCommand(
      command.kind,
      "invalid_edit",
      error instanceof Error ? error.message : "Invalid rehearsal edit.",
    );
  }
  const prepared = await prepareRehearsalEdit(plan, edit);
  if (prepared.kind === "rejected")
    return rejectedCommand(command.kind, "invalid_edit", prepared.message);
  if (prepared.edit.plan.fingerprint === plan.fingerprint)
    return rejectedCommand(
      command.kind,
      "invalid_edit",
      "That edit leaves the rehearsal unchanged.",
    );
  return { kind: "rehearsal_edit", command, edit: prepared.edit };
}

// The chat edit as the operator would make it in Edit trays.
async function rehearsalEdit(
  plan: ProductionWorkcells,
  edit: Exclude<
    BakeryRehearsalEdit,
    {
      kind:
        | "replace_preset"
        | "clear_results"
        | "remove_tray"
        | "set_ingredients"
        | "set_cell"
        | "add_human_transfer";
    }
  >,
): Promise<RehearsalEdit> {
  switch (edit.kind) {
    case "set_faults":
      return { kind: "faults", faults: parseRunFaults(edit.faults) };
    case "add_tray_chain":
      return trayChainEdit(edit.rackCase);
    case "set_baker":
      if (edit.baker > plan.settings.workerCount)
        throw new Error(
          `Choose a baker from 1 to ${plan.settings.workerCount}.`,
        );
      return {
        kind: "worker",
        batchId: edit.batchId,
        workerId: `human-${edit.baker}`,
      };
    case "set_start":
      return {
        kind: "start",
        operationId: edit.operationId,
        earliestStartSeconds: edit.earliestStartSeconds,
      };
    case "set_prerequisites": {
      const steps = [...plan.operations, ...plan.planned];
      for (const id of edit.dependsOn) {
        const step = steps.find(hasId.bind(null, id));
        if (step === undefined || step.batchId === edit.batchId)
          throw new Error(
            "Prerequisites are steps of other trays in this rehearsal.",
          );
      }
      return {
        kind: "prerequisites",
        batchId: edit.batchId,
        dependsOn: edit.dependsOn,
      };
    }
  }
}

async function prepareProductionCommand(
  state: SimulatorState,
  command: Variant<
    BakerySurfaceCommandV1,
    "edit_production" | "preview_production" | "apply_production"
  >,
  digest: SurfaceDigest,
): Promise<
  PreparedBakerySurfaceCommand | RejectedBakerySurfaceCommandResultV1
> {
  const session = authorableProduction(state);
  const material = session === null ? null : productionDraftMaterial(session);
  if (session === null || material === null)
    return rejectedCommand(
      command.kind,
      "stale_surface",
      "Prepare a financier production run, and wait for any open, save or read to finish.",
    );
  if ((await digest(material)) !== command.draftDigest)
    return rejectedCommand(
      command.kind,
      "stale_draft",
      "The production draft changed after this command was prepared.",
    );
  switch (command.kind) {
    case "edit_production": {
      if (command.edit.kind === "prepare_replacement") {
        if (!canReplaceProduction(state))
          return rejectedCommand(
            command.kind,
            "stale_surface",
            "Resolve running work, pending results and save outcomes before preparing a replacement.",
          );
        const result = await prepareProductionReplacement(
          session,
          command.edit.source,
          activeRun(state).settings,
          session.sourceProcedure ?? shiftProcedure(state),
          state.run.layout,
        );
        return result.kind === "rejected"
          ? rejectedCommand(command.kind, "invalid_edit", result.message)
          : {
              kind: "production_replacement",
              command,
              material,
              review: result.review,
            };
      }
      const edit = productionDraftEdit(command.edit);
      const result = editProductionDraft(session, edit);
      if (result.kind === "rejected")
        return rejectedCommand(command.kind, "invalid_edit", result.message);
      const edited = { ...session, ...result.patch };
      if (
        command.edit.kind === "discard_draft"
          ? productionDraftMaterial(edited) === material
          : draftContent(edited) === draftContent(session)
      )
        return rejectedCommand(
          command.kind,
          "invalid_edit",
          "That edit leaves the production draft unchanged.",
        );
      return { kind: "production_draft", command, material, edit };
    }
    case "preview_production": {
      const preview = await prepareProductionPreview(
        session,
        shiftProcedure(state),
        state.run.layout,
      );
      if (preview === null)
        return rejectedCommand(
          command.kind,
          "stale_surface",
          "The production run changed before its draft compiled.",
        );
      if (preview.result.kind === "rejected")
        return rejectedCommand(
          command.kind,
          "invalid_edit",
          preview.result.message,
        );
      return { kind: "production_preview", command, material, preview };
    }
    case "apply_production": {
      const preview = applicablePreview(state);
      if (preview?.plan.fingerprint === command.planFingerprint)
        return { kind: "production_apply", command, material, preview };
      // As the Apply button does: accepted results need the operator's
      // replacement review.
      if (
        reviewablePreview(state)?.plan.fingerprint !== command.planFingerprint
      )
        return rejectedCommand(
          command.kind,
          "stale_surface",
          "Apply needs the reviewed preview, no result waiting for review, no running job and no unresolved save.",
        );
      const result = await prepareProductionReplacement(
        session,
        "preview",
        activeRun(state).settings,
        session.sourceProcedure ?? shiftProcedure(state),
        state.run.layout,
      );
      return result.kind === "rejected"
        ? rejectedCommand(command.kind, "invalid_edit", result.message)
        : {
            kind: "production_replacement",
            command,
            material,
            review: result.review,
          };
    }
  }
}

// The draft an edit changes, apart from its preview and copy identity.
function draftContent(session: ProductionSession): string {
  return JSON.stringify([
    session.draft,
    session.manualTasks,
    session.draftVariant,
  ]);
}

// The chat edit as the operator would make it in Edit production.
function productionDraftEdit(
  edit: Exclude<BakeryProductionEdit, { kind: "prepare_replacement" }>,
): ProductionDraftEdit {
  switch (edit.kind) {
    case "assign_tray":
      return { kind: "assign", batchId: edit.batchId, tray: edit.tray };
    case "unassign_tray":
      return { kind: "unassign", batchId: edit.batchId, tray: edit.tray };
    case "set_baker":
      return {
        kind: "worker",
        id: productionAssignmentId(edit),
        workerId: `human-${edit.baker}`,
      };
    case "set_prerequisites":
      return {
        kind: "prerequisites",
        id: productionAssignmentId(edit),
        dependsOn: edit.dependsOn,
      };
    case "set_start":
      return {
        kind: "start",
        id: productionAssignmentId(edit),
        earliestStartSeconds: edit.earliestStartSeconds,
      };
    case "set_manual_task":
      return {
        kind: "manual",
        task: {
          bakeryTaskId: edit.bakeryTaskId,
          workerId: edit.baker === null ? null : `human-${edit.baker}`,
          dependsOn: edit.dependsOn,
          earliestStartSeconds: edit.earliestStartSeconds,
        },
      };
    case "set_variant":
      return { kind: "variant", variant: edit.variant };
    case "discard_draft":
      return { kind: "discard" };
  }
}

// The checks of Rotate 90°: equipment the floor plan can turn, still at the
// rotation the agent saw.
export function equipmentRotationRejected(
  command: Variant<BakerySurfaceCommandV1, "rotate_equipment">,
  layout: BakerySurfaceShiftLayout | null,
): RejectedBakerySurfaceCommandResultV1 | null {
  const equipment = layout?.equipment.find(
    (item) => item.id === command.applianceId,
  );
  if (equipment === undefined)
    return rejectedCommand(
      command.kind,
      "target_not_found",
      "That appliance is not on the open floor plan.",
    );
  return equipment.rotationDegrees === command.rotationDegrees
    ? null
    : rejectedCommand(
        command.kind,
        "stale_surface",
        `${equipment.label} turned since the context was read. Inspect it again.`,
      );
}

export function equipmentMoveRejected(
  command: Variant<BakerySurfaceCommandV1, "move_equipment">,
  layout: BakerySurfaceShiftLayout | null,
): RejectedBakerySurfaceCommandResultV1 | null {
  const equipment = layout?.equipment.find(
    (item) => item.id === command.applianceId,
  );
  return equipment === undefined
    ? rejectedCommand(
        command.kind,
        "target_not_found",
        "That appliance is not on the open floor plan.",
      )
    : null;
}

export function equipmentAngleRejected(
  command: Variant<BakerySurfaceCommandV1, "set_equipment_angle">,
  layout: BakerySurfaceShiftLayout | null,
): RejectedBakerySurfaceCommandResultV1 | null {
  const equipment = layout?.equipment.find(
    (item) => item.id === command.applianceId,
  );
  return equipment === undefined
    ? rejectedCommand(
        command.kind,
        "target_not_found",
        "That appliance is not on the open floor plan.",
      )
    : null;
}

export function floorPlanResetRejected(
  command: Variant<BakerySurfaceCommandV1, "reset_floor_plan">,
  layout: BakerySurfaceShiftLayout | null,
): RejectedBakerySurfaceCommandResultV1 | null {
  if (layout === null)
    return rejectedCommand(
      command.kind,
      "unsupported_command",
      "The floor plan is not open.",
    );
  const history = layout.history;
  if (history === undefined) return null;
  if (command.action === "undo" && !history.canUndo)
    return rejectedCommand(
      command.kind,
      "invalid_edit",
      "There is no floor plan action to undo.",
    );
  if (command.action === "redo" && !history.canRedo)
    return rejectedCommand(
      command.kind,
      "invalid_edit",
      "There is no floor plan action to redo.",
    );
  if (command.action === "reset_appliances" && !history.hasCustomLayout)
    return rejectedCommand(
      command.kind,
      "invalid_edit",
      "Appliance placements are already at their room defaults.",
    );
  if (
    command.action === "reset_initial" &&
    !history.canUndo &&
    !history.canRedo &&
    !history.hasCustomLayout
  )
    return rejectedCommand(
      command.kind,
      "invalid_edit",
      "The floor plan is already at its initial layout.",
    );
  return null;
}

export function openingToggleRejected(
  command: Variant<BakerySurfaceCommandV1, "toggle_opening">,
  layout: BakerySurfaceShiftLayout | null,
): RejectedBakerySurfaceCommandResultV1 | null {
  const opening = layout?.openings?.find(
    (item) => item.id === command.openingId,
  );
  return opening === undefined
    ? rejectedCommand(
        command.kind,
        "target_not_found",
        "That door or window is not on the open floor plan.",
      )
    : null;
}

export function matchingProposal(
  state: SimulatorState,
  command: Variant<BakerySurfaceCommandV1, "apply_reviewed_edit">,
): BakerySurfaceEditProposalV1 | null {
  const proposal = state.scenario.surfaceEditProposal;
  return proposal === null ||
    proposal.proposalDigest !== command.proposalDigest ||
    !sameDraftReference(proposal.baseDraft, command.baseDraft)
    ? null
    : proposal;
}

async function bakerySurfaceDraftSnapshot(
  state: SimulatorState,
  digest: SurfaceDigest,
): Promise<
  | Readonly<{
      kind: "ready";
      value: Readonly<{
        reference: BakerySurfaceDraftReference;
        values: Settings;
      }>;
    }>
  | RejectedBakerySurfaceCommandResultV1
> {
  const values = currentDraftSettings(state);
  if (values.kind === "invalid")
    return rejectedCommand("read_draft", "invalid_edit", values.message);
  return {
    kind: "ready",
    value: {
      reference: await bakerySurfaceDraftReference(state, digest),
      values: values.settings,
    },
  };
}

function currentDraftSettings(
  state: SimulatorState,
):
  | Readonly<{ kind: "valid"; settings: Settings }>
  | Readonly<{ kind: "invalid"; message: string }> {
  const raw = {
    ...normalSettings(state),
    ...Object.fromEntries(state.scenario.assumptionDraft),
  };
  if (state.run.shift.kind === "procedure") {
    const parsed = parseProcedureAssumptions(
      state.run.shift.normal.source,
      raw,
    );
    return parsed.kind === "invalid"
      ? parsed
      : { kind: "valid", settings: parsed.procedure.settings };
  }
  const parsed = parseSettings(raw);
  return parsed.kind === "invalid"
    ? parsed
    : { kind: "valid", settings: parsed.settings };
}

export function staleSurface(
  state: SimulatorState,
  command: BakerySurfaceCommandV1,
): RejectedBakerySurfaceCommandResultV1 | null {
  return command.target.surfaceSessionId !== state.workspace.surfaceSessionId ||
    command.target.surfaceEpoch !== state.workspace.surfaceEpoch
    ? rejectedCommand(
        command.kind,
        "stale_surface",
        "The Kitchen workspace changed after this command was prepared.",
      )
    : null;
}

function queryShiftTasks(
  state: SimulatorState,
  filter: Variant<BakerySurfaceCommandV1, "query_tasks">["filter"],
): readonly BakerySurfaceTaskDetail[] {
  const run = activeRun(state);
  const query = filter.text.toLocaleLowerCase();
  const tasks: BakerySurfaceTaskDetail[] = [];
  for (const interval of run.intervals) {
    if (interval.kind === "wait") continue;
    const detail = shiftTaskDetail(
      run,
      interval,
      simulatorShellView(state).playback.time,
    );
    const searchable = [
      detail.id,
      detail.name,
      detail.batchId,
      ...detail.resources,
      ...detail.constraints,
    ]
      .join(" ")
      .toLocaleLowerCase();
    if (searchable.includes(query)) tasks.push(detail);
    if (tasks.length === filter.limit) break;
  }
  return tasks;
}

function sameDraftReference(
  left: BakerySurfaceDraftReference,
  right: BakerySurfaceDraftReference,
): boolean {
  return left.revision === right.revision && left.digest === right.digest;
}

// The checks of Apply changes: the exact draft, inputs the operator may
// change, and valid values. The operator's unapplied changes stay theirs.
async function prepareShiftRun(
  state: SimulatorState,
  command: Variant<BakerySurfaceCommandV1, "run_shift">,
  digest: SurfaceDigest,
): Promise<
  PreparedBakerySurfaceCommand | RejectedBakerySurfaceCommandResultV1
> {
  const current = await bakerySurfaceDraftReference(state, digest);
  if (!sameDraftReference(current, command.baseDraft))
    return rejectedCommand(
      command.kind,
      "stale_draft",
      "The Kitchen draft changed. Read it again before running the shift.",
    );
  if (state.procedureLoad.kind === "loading")
    return rejectedCommand(
      command.kind,
      "unsupported_command",
      "The recipe is still loading. Run the shift after it loads.",
    );
  if (state.scenario.assumptionDraft.size > 0)
    return rejectedCommand(
      command.kind,
      "unsupported_command",
      "The operator has unapplied input changes. Ask them to apply or discard those changes first.",
    );
  const fixed = command.edits.find(fixedShiftInput.bind(null, state));
  if (fixed !== undefined)
    return rejectedCommand(
      command.kind,
      "invalid_edit",
      `${surfaceEditSummary(fixed)} cannot change: the recipe fixes that input.`,
    );
  const result = runShiftInputs(
    state,
    new Map(command.edits.map(shiftRunValue)),
  );
  if (result.kind === "invalid")
    return rejectedCommand(command.kind, "invalid_edit", result.message);
  return {
    kind: "shift_run",
    command,
    draftMaterial: bakerySurfaceDraftMaterial(state),
    shift: result.shift,
    copyId: `scenario-${crypto.randomUUID()}`,
    notice:
      command.edits.length === 0
        ? `The agent re-ran the shift with the applied inputs. ${SHIFT_RUN_NOTICE}`
        : `The agent ran the shift with ${command.edits.map(surfaceEditSummary).join(", ")}. ${SHIFT_RUN_NOTICE}`,
  };
}

function fixedShiftInput(
  state: SimulatorState,
  edit: BakerySurfaceEditOperation,
): boolean {
  return !shiftInputEditable(state, edit.field);
}

function shiftRunValue(
  edit: BakerySurfaceEditOperation,
): readonly [SettingsField, number] {
  return [edit.field, edit.value];
}

function previewSurfaceEdits(
  state: SimulatorState,
  edits: readonly BakerySurfaceEditOperation[],
):
  | Readonly<{
      kind: "valid";
      value: BakerySurfaceEditProposalV1["preview"];
    }>
  | Readonly<{ kind: "invalid"; message: string }> {
  const raw = {
    ...normalSettings(state),
    ...Object.fromEntries(state.scenario.assumptionDraft),
  };
  for (const edit of edits) raw[edit.field] = edit.value;
  let settings: Settings;
  if (state.run.shift.kind === "procedure") {
    const result = parseProcedureAssumptions(
      state.run.shift.normal.source,
      raw,
    );
    if (result.kind === "invalid") return result;
    settings = result.procedure.settings;
  } else {
    const result = parseSettings(raw);
    if (result.kind === "invalid") return result;
    settings = result.settings;
  }
  return {
    kind: "valid",
    value: {
      before: runPreview(activeRun(state)),
      after: runPreview(
        simulate(settings, state.run.variant, state.run.layout),
      ),
    },
  };
}

function surfaceEditSummary(edit: BakerySurfaceEditOperation): string {
  const field = fields.find(fieldMatches.bind(null, edit.field));
  return `${field?.label ?? edit.field}: ${edit.value}`;
}

function fieldMatches(
  key: BakerySurfaceEditOperation["field"],
  field: (typeof fields)[number],
): boolean {
  return field.key === key;
}
