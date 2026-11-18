import { HUMAN_CELL_TRANSFER } from "@seams/production-simulation/recipes/bakery/human-cell-transfer";
import {
  prepareProductionFile,
  exportProductionFile,
  type BakeryExportFile,
} from "./production-files.ts";
import type { ProductionPending } from "./production-session.ts";
import type { ScenarioRead } from "./scenario-api.ts";
import { sameScenarioCopy } from "./workspace-commands.ts";
import { sameDefinition } from "./production-scenario-api.ts";
import type { RunSnapshotPage } from "@seams/bakery-model/bakery-run-snapshot";
import {
  prepareProductionNavigation,
  type ProductionNavigation,
} from "./production-navigation.ts";
import {
  acceptedProductionResults,
  prepareProductionReplacement,
  type PreparedProductionReplacement,
} from "./production-draft.ts";
import { isRehearsalChange } from "@seams/bakery-model/bakery-surface";
import {
  prepareRehearsalReview,
  type PreparedRehearsalReview,
} from "./rehearsal-edits.ts";
import { summarizeRun } from "@seams/production-simulation/simulator/run-comparison";
import type { BakeryRunComparison } from "@seams/bakery-model/bakery-surface";
import {
  NO_FAULTS,
  parseRunFaults,
} from "@seams/production-simulation/recipes/bakery/run-faults";
import { applyPlaybackAction, playbackAvailable } from "./playback-actions.ts";
import {
  canPrepareWorkcell,
  prepareWorkcell,
  applyWorkcellPreparation,
  type PreparedWorkcell,
} from "./workcell-preparation.ts";
import {
  prepareRackLayout,
  evaluateRackLayout,
  rackOffset,
  type RackLayoutProposal,
  type RackLayoutReview,
} from "./rack-layout.ts";
import type {
  BakeryRunSaveInspection,
  BakeryScenarioSaveInspection,
  BakeryFileManifest,
  BakerySurfaceRackLayout,
  BakerySurfaceTrayLayout,
} from "@seams/bakery-model/bakery-surface";
import {
  acceptProductionCandidate,
  layoutTray,
  pendingOperationContext,
  pendingSimulation,
  selectedTray,
  stepLabel,
} from "./scheduled-rehearsal.ts";
import {
  exportRehearsalWorkcells,
  type PlannedProductionWorkcell,
  type ProductionWorkcell,
  type ProductionWorkcells,
  type RehearsalEdit,
} from "@seams/production-simulation/recipes/bakery/production-workcells";
import type {
  ProductionReady,
  ProductionSession,
} from "./production-session.ts";
import {
  editProductionDraft,
  prepareProductionPreview,
  productionDraftSource,
  type PreparedProductionPreview,
  type ProductionDraftEdit,
} from "./production-draft.ts";
import {
  productionAssignmentId,
  type ProductionAssignment,
  type ProductionManualTask,
} from "@seams/bakery-model/bakery-production-scenario";
import {
  prepareRehearsalEdit,
  trayChainEdit,
  type PreparedRehearsalEdit,
} from "./rehearsal-edits.ts";
import {
  type CellId,
  resourceInstance,
} from "@seams/production-simulation/recipes/bakery/workcell-instances";
import {
  createBakerySurfaceAttachment,
  type BakerySurfaceAttachmentV1,
  type BakerySurfaceCommandResultV1,
  type RejectedBakerySurfaceCommandResultV1,
  type BakerySurfaceCommandV1,
  type BakerySurfaceContextV1,
  type BakerySurfaceDraftReference,
  type BakerySurfaceEditOperation,
  type BakerySurfaceShiftLayout,
  type BakerySurfaceEditProposalV1,
  type BakerySurfaceRunSaveManifest,
  type BakerySurfaceToolCommandName,
  type BakerySurfaceRunPreview,
  type BakerySurfaceRehearsalTray,
  type BakeryRehearsalEdit,
  type BakeryProductionEdit,
  type BakerySurfaceManualTask,
  type BakerySurfaceProductionAssignment,
  type BakerySurfaceProductionDraft,
  type BakerySurfaceScheduledRehearsal,
  type BakerySurfacePlayback,
  type BakerySurfaceSelection,
  type BakeryDoorInspection,
  type BakerySurfaceSummary,
  type BakerySurfaceTaskDetail,
  type BakeryRecordingAcceptanceReference,
} from "@seams/bakery-model/bakery-surface";
import {
  currentRecordingAcceptanceReference,
  resolveRecordingAcceptanceReference,
} from "./recording-acceptance.ts";
import type {
  PhysicsReplay,
  PhysicsRequest,
} from "@seams/bakery-model/bakery-physics";
import {
  physicsResources,
  physicsTasks,
} from "@seams/production-simulation/recipes/bakery/physics-playback";
import {
  prepareRecordingNavigation,
  recordingHasDoor,
  type RecordingDocument,
  type RecordingNavigation,
} from "@seams/production-simulation/simulator/playback-state";
import {
  fields,
  parseSettings,
  type Settings,
  type SettingsField,
} from "@seams/bakery-model/bakery";
import { parseProcedureAssumptions } from "@seams/bakery-model/bakery-procedure";
import {
  metrics,
  simulate,
  type Run,
  type BakeryTask,
} from "@seams/production-simulation/recipes/bakery/schedule";
import {
  activeRun,
  canReviewRehearsal,
  normalRun,
  canReplaceProduction,
  applySimulatorExperimentAction,
  applySimulatorViewAction,
  applySimulatorBrowserStop,
  applySimulatorReplayAction,
  simulatorShellView,
  applyBakeryWorkspaceAction,
  type RecordingAcceptanceTarget,
  type PreparedRecordingAcceptance,
  type SimulatorShift,
  type SimulatorState,
  type WorkspaceRunSaveStatus,
} from "./simulator-state.ts";
import {
  runShiftInputs,
  shiftInputEditable,
  SHIFT_RUN_NOTICE,
} from "./shift-run.ts";
import { selectionContext, type Selection } from "@seams/production-simulation/simulator/selection";
import {
  verifyStoredWorkspaceRun,
  readWorkspaceRuns,
  prepareRehearsalRunWorkspace,
  openRehearsalRunWorkspace,
  openProductionWorkspaceRun,
  type PreparedWorkspaceRun,
} from "./workspace-runs-api.ts";
import { rehearsalSettings } from "@seams/production-simulation/simulator/rehearsal-presets";
import {
  prepareWorkspaceRunReview,
  workspaceRunReviewSummary,
  type WorkspaceRunReview,
} from "./workspace-run-review.ts";
import { canOpenWorkspaceRun, shiftProcedure } from "./simulator-state.ts";
import type { ProductionScenarioRead } from "./production-scenario-api";
import { bakeryFingerprint } from "@seams/bakery-model/bakery";
import { parseScenarioCopy } from "@seams/bakery-model/bakery-scenario";
import {
  parseProductionScenario,
  productionDefinitionFingerprint,
} from "@seams/bakery-model/bakery-production-scenario";
import {
  agentScenarioSaveManifest,
  type AgentScenarioSavePayload,
  type AgentScenarioSaveManifest,
} from "@seams/bakery-model/bakery-agent-scenario-save";
import type { Variant } from "@seams/type-utils";
import { assertNever, canonicalJson, sha256Hex } from "@seams/std";

export type BakerySurfaceCommandTransition =
  | Readonly<{ kind: "applied"; state: SimulatorState }>
  | RejectedBakerySurfaceCommandResultV1;

export type BakerySurfaceCommandOrigin =
  | Readonly<{ kind: "local" }>
  | Readonly<{ kind: "agent_effect"; effectId: string }>;

type SurfaceDigest = (value: string) => Promise<string>;

export type BakeryWorkspaceRead = Readonly<{
  organisationId: string;
  read(path: string): Promise<unknown>;
  readAttachment(digest: string): BakeryExportFile;
  readScenario(
    organisationId: string,
    scenarioId: string,
  ): Promise<ScenarioRead>;
  readDefinition(
    organisationId: string,
    scenarioId: string,
  ): Promise<ProductionScenarioRead>;
}>;

export type PreparedBakerySurfaceCommand =
  | Readonly<{
      kind: "file";
      command: Variant<BakerySurfaceCommandV1, "file_action">;
      source: ProductionSession;
      manifest: BakeryFileManifest;
      prepared:
        | Readonly<{
            kind: "import";
            pending: Exclude<ProductionPending, { kind: "none" }>;
          }>
        | Readonly<{ kind: "export"; file: BakeryExportFile }>;
    }>
  | Readonly<{
      kind: "scenario_inspection";
      command: Variant<BakerySurfaceCommandV1, "inspect_scenario_save">;
      source: SimulatorState["workspace"]["scenarioSaveProposal"];
      inspection: BakeryScenarioSaveInspection;
    }>
  | Readonly<{
      kind: "save_inspection";
      command: Variant<BakerySurfaceCommandV1, "inspect_run_save">;
      source: WorkspaceRunSaveStatus;
      inspection: BakeryRunSaveInspection;
    }>
  | Readonly<{
      kind: "saved_runs";
      command: Variant<BakerySurfaceCommandV1, "list_saved_runs">;
      page: RunSnapshotPage;
    }>
  | Readonly<{
      kind: "run_open";
      command: Variant<BakerySurfaceCommandV1, "prepare_run_open">;
      review: WorkspaceRunReview;
    }>
  | Readonly<{
      kind: "simulation_stop";
      command: Variant<BakerySurfaceCommandV1, "stop_simulation">;
    }>
  | Readonly<{
      kind: "workspace_view";
      command: Variant<BakerySurfaceCommandV1, "control_workspace_view">;
    }>
  | Readonly<{
      kind: "discard";
      command: Variant<BakerySurfaceCommandV1, "discard_candidate">;
      target: RecordingAcceptanceTarget;
    }>
  | Readonly<{
      kind: "production_panel";
      command: Variant<BakerySurfaceCommandV1, "show_production_panel">;
      from: ProductionReady;
    }>
  | Readonly<{
      kind: "production_replacement";
      command: Variant<
        BakerySurfaceCommandV1,
        "edit_production" | "apply_production"
      >;
      material: string;
      review: PreparedProductionReplacement;
    }>
  | Readonly<{
      kind: "rehearsal_review";
      command: Variant<BakerySurfaceCommandV1, "edit_rehearsal">;
      review: PreparedRehearsalReview;
    }>
  | Readonly<{
      kind: "baseline";
      command: Variant<BakerySurfaceCommandV1, "control_baseline">;
      source: Run;
      baseline: ProductionSession["baseline"];
    }>
  | Readonly<{
      kind: "workcell_preparation";
      command: Variant<BakerySurfaceCommandV1, "prepare_workcell">;
      prepared: PreparedWorkcell;
    }>
  | Readonly<{
      kind: "playback";
      command: Variant<BakerySurfaceCommandV1, "control_playback">;
    }>
  | Readonly<{
      kind: "tray_layout";
      command: Variant<BakerySurfaceCommandV1, "prepare_layout">;
      baseLayout: ProductionSession["layout"];
      operationId: string;
      proposal: RackLayoutProposal;
    }>
  | Readonly<{
      kind: "production_view";
      command: Variant<BakerySurfaceCommandV1, "set_view">;
      navigation: ProductionNavigation;
    }>
  | Readonly<{
      kind: "recording_view";
      command: Variant<BakerySurfaceCommandV1, "set_view">;
      navigation: RecordingNavigation;
    }>
  | Readonly<{
      kind: "rehearsal_edit";
      command: Variant<BakerySurfaceCommandV1, "edit_rehearsal">;
      edit: PreparedRehearsalEdit;
    }>
  // Financier authoring, each bound to the draft material it was prepared
  // from.
  | Readonly<{
      kind: "production_draft";
      command: Variant<BakerySurfaceCommandV1, "edit_production">;
      material: string;
      edit: ProductionDraftEdit;
    }>
  | Readonly<{
      kind: "production_preview";
      command: Variant<BakerySurfaceCommandV1, "preview_production">;
      material: string;
      preview: PreparedProductionPreview;
    }>
  | Readonly<{
      kind: "production_apply";
      command: Variant<BakerySurfaceCommandV1, "apply_production">;
      material: string;
      preview: ProductionReady;
    }>
  // The recipe catalog's financier run, opened from the shift.
  | Readonly<{
      kind: "production_start";
      command: Variant<BakerySurfaceCommandV1, "start_production">;
    }>
  // A Details chip, a 3D click or a Compare shifts option.
  | Readonly<{
      kind: "shift_view";
      command: Variant<BakerySurfaceCommandV1, "select_item" | "compare_shift">;
      selection: Selection | null;
    }>
  // Rotate 90° on one appliance of the open floor plan. The route turns it,
  // and the schedule follows the placement.
  | Readonly<{
      kind: "equipment_rotation";
      command: Variant<BakerySurfaceCommandV1, "rotate_equipment">;
      floorPlan: string;
    }>
  | Readonly<{
      kind: "equipment_angle";
      command: Variant<BakerySurfaceCommandV1, "set_equipment_angle">;
      floorPlan: string;
    }>
  | Readonly<{
      kind: "equipment_move";
      command: Variant<BakerySurfaceCommandV1, "move_equipment">;
      floorPlan: string;
    }>
  | Readonly<{
      kind: "opening_toggle";
      command: Variant<BakerySurfaceCommandV1, "toggle_opening">;
      floorPlan: string;
    }>
  | Readonly<{
      kind: "floor_plan_select";
      command: Variant<BakerySurfaceCommandV1, "select_floor_plan">;
    }>
  | Readonly<{
      kind: "interior_configure";
      command: Variant<BakerySurfaceCommandV1, "configure_interior">;
    }>
  | Readonly<{
      kind: "floor_plan_reset";
      command: Variant<BakerySurfaceCommandV1, "reset_floor_plan">;
      floorPlan: string;
    }>
  // A shift run, computed as Apply changes computes it, from the draft
  // material it was prepared against.
  | Readonly<{
      kind: "shift_run";
      command: Variant<BakerySurfaceCommandV1, "run_shift">;
      draftMaterial: string;
      shift: SimulatorShift;
      copyId: string;
      notice: string;
    }>
  | Readonly<{
      kind: "read";
      command: Variant<
        BakerySurfaceCommandV1,
        "inspect_surface" | "read_draft" | "query_tasks"
      >;
      draftMaterial: string | null;
      draft: Readonly<{
        reference: BakerySurfaceDraftReference;
        values: Settings;
      }> | null;
      tasks: readonly BakerySurfaceTaskDetail[] | null;
    }>
  | Readonly<{
      kind: "accept";
      command: Variant<BakerySurfaceCommandV1, "accept_candidate">;
      target: PreparedRecordingAcceptance;
    }>
  | Readonly<{
      kind: "run_save";
      command: Variant<BakerySurfaceCommandV1, "prepare_run_save">;
      prepared: PreparedWorkspaceRun;
      sourceFile: string;
    }>
  | Readonly<{
      kind: "scenario_save";
      command: Variant<BakerySurfaceCommandV1, "prepare_scenario_save">;
      payload: AgentScenarioSavePayload;
      manifest: AgentScenarioSaveManifest;
      sourceKey: string;
    }>
  | Readonly<{
      kind: "write";
      command: Exclude<
        BakerySurfaceCommandV1,
        {
          kind:
            | "inspect_surface"
            | "read_draft"
            | "query_tasks"
            | "stop_simulation"
            | "simulate_workcell"
            | "control_baseline"
            | "show_production_panel"
            | "control_workspace_view"
            | "control_playback"
            | "prepare_workcell"
            | "accept_candidate"
            | "discard_candidate"
            | "prepare_layout"
            | "prepare_run_save"
            | "file_action"
            | "inspect_scenario_save"
            | "inspect_run_save"
            | "list_saved_runs"
            | "prepare_run_open"
            | "prepare_scenario_save"
            | "edit_rehearsal"
            | "edit_production"
            | "preview_production"
            | "apply_production"
            | "run_shift"
            | "select_item"
            | "rotate_equipment"
            | "set_equipment_angle"
            | "move_equipment"
            | "toggle_opening"
            | "select_floor_plan"
            | "configure_interior"
            | "reset_floor_plan"
            | "compare_shift"
            | "start_production";
        }
      >;
      draftMaterial: string | null;
      proposal: BakerySurfaceEditProposalV1 | null;
    }>;

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

function simulationMatches(
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
function rehearsalSaveSource(
  state: SimulatorState,
): ProductionWorkcells | null {
  return scheduledSession(state)?.data.plan ?? null;
}

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

function scenarioSaveSourceKey(state: SimulatorState): string | null {
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

function sameSettings(left: Settings, right: Settings): boolean {
  for (const field of fields)
    if (left[field.key] !== right[field.key]) return false;
  return true;
}

export function validatePreparedBakerySurfaceRead(
  state: SimulatorState,
  prepared: Variant<
    PreparedBakerySurfaceCommand,
    "read" | "saved_runs" | "save_inspection" | "scenario_inspection"
  >,
): RejectedBakerySurfaceCommandResultV1 | null {
  const stale = staleSurface(state, prepared.command);
  if (stale !== null) return stale;
  if (
    prepared.kind === "scenario_inspection" &&
    state.workspace.scenarioSaveProposal !== prepared.source
  )
    return rejectedCommand(
      prepared.command.kind,
      "stale_surface",
      "The scenario save changed during inspection. Inspect its current status again.",
    );
  if (
    prepared.kind === "save_inspection" &&
    state.workspace.runSaves[prepared.command.runKind] !== prepared.source
  )
    return rejectedCommand(
      prepared.command.kind,
      "stale_surface",
      "The save attempt changed during inspection. Inspect its current status again.",
    );
  if (
    prepared.kind === "read" &&
    prepared.command.kind === "read_draft" &&
    (prepared.draft === null ||
      prepared.draftMaterial !== bakerySurfaceDraftMaterial(state) ||
      prepared.draft.reference.revision !== state.scenario.draftRevision)
  )
    return rejectedCommand(
      "read_draft",
      "stale_draft",
      "The Kitchen draft changed while its exact values were being read.",
    );
  return null;
}

export function commitBakerySurfaceCommand(
  state: SimulatorState,
  prepared: Exclude<
    PreparedBakerySurfaceCommand,
    {
      kind: "read" | "saved_runs" | "save_inspection" | "scenario_inspection";
    }
  >,
  origin: BakerySurfaceCommandOrigin,
): BakerySurfaceCommandTransition {
  const stale = staleSurface(state, prepared.command);
  if (stale !== null) return stale;
  if (prepared.kind === "simulation_stop")
    return simulationMatches(state, prepared.command)
      ? {
          kind: "applied",
          state: applySimulatorBrowserStop(true, state),
        }
      : rejectedCommand(
          prepared.command.kind,
          "stale_surface",
          "The running simulation changed before Stop committed.",
        );
  if (prepared.kind === "workcell_preparation") {
    const next = applyWorkcellPreparation(state, prepared.prepared);
    return next === state
      ? rejectedCommand(
          prepared.command.kind,
          "stale_surface",
          "The workcell changed before preparation could be applied.",
        )
      : { kind: "applied", state: next };
  }
  if (prepared.kind === "run_open") {
    const next = applyBakeryWorkspaceAction(
      { kind: "workspaceRunOpenPrepared", review: prepared.review },
      state,
    );
    return next === state
      ? rejectedCommand(
          prepared.command.kind,
          "stale_surface",
          "The run or its draft changed while the saved copy was being read.",
        )
      : { kind: "applied", state: next };
  }
  if (prepared.kind === "baseline") {
    const next = applyBakeryWorkspaceAction(
      {
        kind: "productionBaselineChanged",
        action: prepared.command.action,
        source: prepared.source,
        baseline: prepared.baseline,
      },
      state,
    );
    return next === state
      ? rejectedCommand(
          prepared.command.kind,
          "stale_surface",
          "The displayed run or its baseline changed before the command committed.",
        )
      : { kind: "applied", state: next };
  }
  if (prepared.kind === "playback") {
    const result = applyPlaybackAction(prepared.command.action, state);
    return result.kind === "unavailable"
      ? rejectedCommand(
          prepared.command.kind,
          "unsupported_command",
          result.message,
        )
      : result;
  }
  if (prepared.kind === "workspace_view")
    return {
      kind: "applied",
      state: applySimulatorViewAction(prepared.command.action, state),
    };
  if (prepared.kind === "production_panel") {
    const next = applyBakeryWorkspaceAction(
      {
        kind: "productionPanelShown",
        from: prepared.from,
        panel: prepared.command.panel,
      },
      state,
    );
    return next === state
      ? rejectedCommand(
          prepared.command.kind,
          "stale_surface",
          "The run changed before its panel could open.",
        )
      : { kind: "applied", state: next };
  }
  if (prepared.kind === "production_view") {
    const next = applyBakeryWorkspaceAction(
      { kind: "productionNavigated", navigation: prepared.navigation },
      state,
    );
    return next === state
      ? rejectedCommand(
          prepared.command.kind,
          "stale_surface",
          "The applied run changed before navigation committed.",
        )
      : { kind: "applied", state: next };
  }
  if (prepared.kind === "recording_view") {
    const next = applySimulatorReplayAction(
      { kind: "recordingNavigated", navigation: prepared.navigation },
      state,
    );
    return next === state
      ? rejectedCommand(
          prepared.command.kind,
          "stale_surface",
          "The recording changed before navigation committed.",
        )
      : { kind: "applied", state: next };
  }
  if (prepared.kind === "rehearsal_review") {
    const next = applyBakeryWorkspaceAction(
      { kind: "rehearsalReviewPrepared", review: prepared.review },
      state,
    );
    return next === state
      ? rejectedCommand(
          prepared.command.kind,
          "stale_surface",
          "The rehearsal changed before its review could be prepared.",
        )
      : { kind: "applied", state: next };
  }
  if (prepared.kind === "file") {
    if (
      state.workspace.production !== prepared.source ||
      !canOpenWorkspaceRun(state)
    )
      return rejectedCommand(
        prepared.command.kind,
        "stale_surface",
        "The run changed while preparing its file. Try again.",
      );
    return {
      kind: "applied",
      state:
        prepared.prepared.kind === "export"
          ? state
          : applyBakeryWorkspaceAction(
              {
                kind: "productionSessionChanged",
                patch: {
                  pending: prepared.prepared.pending,
                  cursor: {
                    time: prepared.source.cursor.time,
                    playback: "paused",
                  },
                  panel: "files",
                  notice: "Attached file checked. Review it before applying.",
                },
              },
              state,
            ),
    };
  }
  if (prepared.kind === "rehearsal_edit") {
    const session = scheduledSession(state);
    const next =
      session === null || !rehearsalEditable(state, session)
        ? state
        : applyBakeryWorkspaceAction(
            { kind: "rehearsalEdited", edit: prepared.edit },
            state,
          );
    return next === state
      ? rejectedCommand(
          prepared.command.kind,
          "stale_surface",
          "The rehearsal changed before the edit could be applied.",
        )
      : { kind: "applied", state: next };
  }
  if (
    prepared.kind === "production_replacement" ||
    prepared.kind === "production_draft" ||
    prepared.kind === "production_preview" ||
    prepared.kind === "production_apply"
  )
    return commitProductionCommand(state, prepared);
  if (prepared.kind === "tray_layout") {
    const session = scheduledSession(state);
    const tray =
      session === null
        ? null
        : layoutTray(session.data.plan, selectedTray(session));
    if (
      session === null ||
      session.layout !== prepared.baseLayout ||
      tray?.id !== prepared.operationId ||
      tray.attempt !== prepared.proposal.previous
    )
      return rejectedCommand(
        prepared.command.kind,
        "stale_surface",
        "The rehearsal changed during layout review.",
      );
    return {
      kind: "applied",
      state: applyBakeryWorkspaceAction(
        {
          kind: "productionSessionChanged",
          patch: {
            layout: {
              operationId: prepared.operationId,
              review: { kind: "prepared", proposal: prepared.proposal },
            },
            panel: "author",
          },
        },
        state,
      ),
    };
  }
  if (prepared.kind === "discard") {
    const next = applyBakeryWorkspaceAction(
      {
        kind: "productionCandidateDiscarded",
        candidate: prepared.target.candidate,
      },
      state,
    );
    return next === state
      ? rejectedCommand(
          prepared.command.kind,
          "stale_surface",
          "The candidate changed before discard.",
        )
      : { kind: "applied", state: next };
  }
  if (prepared.kind === "accept") {
    const accepted = applyBakeryWorkspaceAction(
      { kind: "acceptRecording", target: prepared.target },
      state,
    );
    if (!candidateWasAccepted(state, accepted))
      return rejectedCommand(
        prepared.command.kind,
        "stale_surface",
        "The recording candidate changed before acceptance.",
      );
    return { kind: "applied", state: accepted };
  }
  if (prepared.kind === "run_save") {
    if (origin.kind !== "agent_effect")
      return rejectedCommand(
        prepared.command.kind,
        "unsupported_command",
        "A run-save proposal requires an agent effect.",
      );
    const source = rehearsalSaveSource(state);
    const status = state.workspace.runSaves.rehearsal;
    if (
      source === null ||
      exportRehearsalWorkcells(source) !== prepared.sourceFile ||
      status.kind === "saving" ||
      status.kind === "outcome-unknown" ||
      status.kind === "saved-readback-failed" ||
      (status.kind === "not-found" &&
        (status.id !== prepared.prepared.id ||
          status.name !== prepared.prepared.snapshot.name))
    )
      return rejectedCommand(
        prepared.command.kind,
        "stale_surface",
        "The rehearsal or save recovery state changed before review was prepared.",
      );
    return {
      kind: "applied",
      state: applyBakeryWorkspaceAction(
        {
          kind: "workspaceRunSaveProposed",
          prepared: prepared.prepared,
          effectId: origin.effectId,
        },
        state,
      ),
    };
  }
  if (prepared.kind === "scenario_save") {
    if (origin.kind !== "agent_effect")
      return rejectedCommand(
        prepared.command.kind,
        "unsupported_command",
        "A scenario-save proposal requires an agent effect.",
      );
    if (
      state.workspace.scenarioSaveProposal.kind !== "none" ||
      scenarioSaveSourceKey(state) !== prepared.sourceKey
    )
      return rejectedCommand(
        prepared.command.kind,
        "stale_surface",
        "The scenario changed while its save was being prepared.",
      );
    return {
      kind: "applied",
      state: applyBakeryWorkspaceAction(
        {
          kind: "scenarioSaveProposed",
          payload: prepared.payload,
          manifest: prepared.manifest,
          effectId: origin.effectId,
        },
        state,
      ),
    };
  }
  if (prepared.kind === "production_start") {
    const opened = applyBakeryWorkspaceAction(
      {
        kind: "openProduction",
        procedure: "financier",
        ...(prepared.command.preset === "one-batch"
          ? { financierPreset: "one-batch" as const }
          : {}),
      },
      applyBakeryWorkspaceAction(
        { kind: "openRehearsal" },
        applySimulatorReplayAction({ kind: "openRecording" }, state),
      ),
    );
    return opened.workspace.kind === "production"
      ? { kind: "applied", state: opened }
      : rejectedCommand(
          prepared.command.kind,
          "stale_surface",
          "The workspace changed before production could open.",
        );
  }
  if (prepared.kind === "shift_view") {
    const command = prepared.command;
    if (command.kind === "select_item") {
      const next =
        prepared.selection === null
          ? state
          : applySimulatorViewAction(
              { kind: "select", selection: prepared.selection },
              state,
            );
      return next === state
        ? rejectedCommand(
            command.kind,
            "target_not_found",
            "The selection is no longer in the displayed run.",
          )
        : { kind: "applied", state: next };
    }
    const compared = applySimulatorReplayAction(
      command.mode === "outage"
        ? { kind: "compareOutage" }
        : { kind: "chooseVariant", variant: "normal" },
      state,
    );
    return {
      kind: "applied",
      state: applySimulatorViewAction(
        { kind: "openDock", dock: "comparison" },
        compared,
      ),
    };
  }
  if (prepared.kind === "equipment_rotation") {
    const layout = shiftLayout();
    const rejected =
      layout?.floorPlan === prepared.floorPlan
        ? equipmentRotationRejected(prepared.command, layout)
        : rejectedCommand(
            prepared.command.kind,
            "stale_surface",
            "The floor plan changed before the equipment could turn.",
          );
    return rejected ?? { kind: "applied", state };
  }
  if (prepared.kind === "equipment_move") {
    const layout = shiftLayout();
    const rejected =
      layout?.floorPlan === prepared.floorPlan
        ? equipmentMoveRejected(prepared.command, layout)
        : rejectedCommand(
            prepared.command.kind,
            "stale_surface",
            "The floor plan changed before the equipment could move.",
          );
    return rejected ?? { kind: "applied", state };
  }
  if (prepared.kind === "opening_toggle") {
    const layout = shiftLayout();
    const rejected =
      layout?.floorPlan === prepared.floorPlan
        ? openingToggleRejected(prepared.command, layout)
        : rejectedCommand(
            prepared.command.kind,
            "stale_surface",
            "The floor plan changed before the opening could toggle.",
          );
    return rejected ?? { kind: "applied", state };
  }
  if (prepared.kind === "floor_plan_select") {
    return shiftLayout() === null
      ? rejectedCommand(
          prepared.command.kind,
          "unsupported_command",
          "The floor plan is not open.",
        )
      : { kind: "applied", state };
  }
  if (prepared.kind === "equipment_angle") {
    const layout = shiftLayout();
    const rejected =
      layout?.floorPlan === prepared.floorPlan
        ? equipmentAngleRejected(prepared.command, layout)
        : rejectedCommand(
            prepared.command.kind,
            "stale_surface",
            "The floor plan changed before the equipment angle could be set.",
          );
    return rejected ?? { kind: "applied", state };
  }
  if (prepared.kind === "interior_configure") {
    return shiftLayout() === null
      ? rejectedCommand(
          prepared.command.kind,
          "unsupported_command",
          "The floor plan is not open.",
        )
      : { kind: "applied", state };
  }
  if (prepared.kind === "floor_plan_reset") {
    const layout = shiftLayout();
    const rejected =
      layout?.floorPlan === prepared.floorPlan
        ? floorPlanResetRejected(prepared.command, layout)
        : rejectedCommand(
            prepared.command.kind,
            "stale_surface",
            "The floor plan changed before the reset could run.",
          );
    return rejected ?? { kind: "applied", state };
  }
  if (prepared.kind === "shift_run") {
    if (
      state.workspace.kind !== "shift" ||
      state.procedureLoad.kind === "loading" ||
      prepared.draftMaterial !== bakerySurfaceDraftMaterial(state) ||
      state.scenario.draftRevision !== prepared.command.baseDraft.revision
    )
      return rejectedCommand(
        prepared.command.kind,
        "stale_draft",
        "The Kitchen inputs changed before the shift could run.",
      );
    return {
      kind: "applied",
      state: applySimulatorExperimentAction(
        {
          kind: "experimentApplied",
          shift: prepared.shift,
          copyId: prepared.copyId,
          notice: prepared.notice,
        },
        state,
      ),
    };
  }
  const command = prepared.command;
  if (command.kind === "prepare_production_control")
    return rejectedCommand(
      command.kind,
      "unsupported_command",
      "Open a persistent production execution for this control.",
    );
  if (state.workspace.kind !== "shift")
    return rejectedCommand(
      command.kind,
      "unsupported_command",
      "This Kitchen workspace does not support that command yet.",
    );
  if (command.kind === "prepare_edit") {
    if (
      prepared.proposal === null ||
      prepared.draftMaterial !== bakerySurfaceDraftMaterial(state) ||
      state.scenario.draftRevision !== command.baseDraft.revision
    )
      return rejectedCommand(
        command.kind,
        "stale_draft",
        "The Kitchen draft changed while this edit was being prepared.",
      );
    return {
      kind: "applied",
      state: applySimulatorExperimentAction(
        { kind: "surfaceEditPrepared", proposal: prepared.proposal },
        state,
      ),
    };
  }
  if (command.kind === "apply_reviewed_edit") {
    const proposal = matchingProposal(state, command);
    if (
      proposal === null ||
      prepared.proposal === null ||
      prepared.proposal.proposalDigest !== proposal.proposalDigest ||
      prepared.draftMaterial !== bakerySurfaceDraftMaterial(state) ||
      state.scenario.draftRevision !== command.baseDraft.revision
    )
      return rejectedCommand(
        command.kind,
        "stale_draft",
        "The Kitchen draft or reviewed proposal changed before it was applied.",
      );
    return {
      kind: "applied",
      state: applySimulatorExperimentAction(
        { kind: "surfaceEditApplied", proposal },
        state,
      ),
    };
  }
  const run = activeRun(state);
  const selection = shiftSelection(run, command.view.selection);
  if (selection === null)
    return rejectedCommand(
      command.kind,
      "target_not_found",
      "The requested Kitchen selection or playback time is unavailable.",
    );
  const navigated = applySimulatorViewAction(
    {
      kind: "navigate",
      selection,
      time: command.view.cursorSeconds,
      focus: "inspector",
    },
    state,
  );
  if (navigated === state)
    return rejectedCommand(
      command.kind,
      "target_not_found",
      "The requested Kitchen selection or playback time is unavailable.",
    );
  return {
    kind: "applied",
    state: navigated,
  };
}

function candidateWasAccepted(
  previous: SimulatorState,
  next: SimulatorState,
): boolean {
  return (
    next !== previous &&
    next.workspace.kind === "production" &&
    next.workspace.production.pending.kind === "none" &&
    next.workspace.production.data.kind === "ready" &&
    next.workspace.production.data.plan !==
      (previous.workspace.kind === "production" &&
      previous.workspace.production.data.kind === "ready"
        ? previous.workspace.production.data.plan
        : null)
  );
}

export async function applyBakerySurfaceCommand(
  state: SimulatorState,
  command: BakerySurfaceCommandV1,
  digest: SurfaceDigest = sha256Hex,
): Promise<BakerySurfaceCommandTransition> {
  const prepared = await prepareBakerySurfaceCommand(state, command, digest);
  if (prepared.kind === "rejected") return prepared;
  return prepared.kind === "read" ||
    prepared.kind === "saved_runs" ||
    prepared.kind === "save_inspection" ||
    prepared.kind === "scenario_inspection"
    ? { kind: "applied", state }
    : commitBakerySurfaceCommand(state, prepared, { kind: "local" });
}

export async function captureBakerySurface(
  state: SimulatorState,
): Promise<BakerySurfaceAttachmentV1> {
  return createBakerySurfaceAttachment(await bakerySurfaceContext(state));
}

export async function bakerySurfaceCommandSucceeded(
  state: SimulatorState,
  prepared: PreparedBakerySurfaceCommand,
): Promise<Variant<BakerySurfaceCommandResultV1, "succeeded">> {
  const surface = await captureBakerySurface(state);
  if (prepared.kind === "file")
    return {
      kind: "succeeded",
      command: "file_action",
      surface,
      output: {
        kind: "file",
        action: prepared.prepared.kind,
        manifest: prepared.manifest,
      },
    };
  if (prepared.kind === "scenario_inspection")
    return {
      kind: "succeeded",
      command: "inspect_scenario_save",
      surface,
      output: {
        kind: "scenario_save_inspection",
        save: prepared.inspection,
      },
    };
  if (prepared.kind === "save_inspection")
    return {
      kind: "succeeded",
      command: "inspect_run_save",
      surface,
      output: {
        kind: "run_save_inspection",
        runKind: prepared.command.runKind,
        save: prepared.inspection,
      },
    };
  if (prepared.kind === "saved_runs")
    return {
      kind: "succeeded",
      command: "list_saved_runs",
      surface,
      output: {
        kind: "saved_runs",
        runKind: prepared.command.runKind,
        cursor: prepared.command.cursor,
        page: prepared.page,
      },
    };
  if (prepared.command.kind === "read_draft") {
    if (prepared.kind !== "read" || prepared.draft === null)
      throw new Error("bakery_surface_draft_result_invalid");
    return {
      kind: "succeeded",
      command: "read_draft",
      surface,
      output: { kind: "draft", draft: prepared.draft },
    };
  }
  if (prepared.command.kind === "query_tasks") {
    if (prepared.kind !== "read" || prepared.tasks === null)
      throw new Error("bakery_surface_task_query_result_invalid");
    return {
      kind: "succeeded",
      command: "query_tasks",
      surface,
      output: { kind: "task_query", tasks: prepared.tasks },
    };
  }
  if (prepared.kind === "run_save") {
    return {
      kind: "succeeded",
      command: "prepare_run_save",
      surface,
      output: {
        kind: "run_save_proposal",
        manifest: runSaveManifest(prepared.prepared),
      },
    };
  }
  if (prepared.kind === "scenario_save")
    return {
      kind: "succeeded",
      command: "prepare_scenario_save",
      surface,
      output: {
        kind: "scenario_save_proposal",
        manifest: prepared.manifest,
      },
    };
  return {
    kind: "succeeded",
    command: prepared.command.kind,
    surface,
    output: { kind: "surface" },
  };
}

function runSaveManifest(
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

type ScheduledSession = ProductionSession &
  Readonly<{
    data: Variant<ProductionSession["data"], "ready">;
  }>;

function scheduledSession(state: SimulatorState): ScheduledSession | null {
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
function rehearsalEditable(
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

// A financier draft chat may edit or preview: no read, open or save runs.
function authorableProduction(state: SimulatorState): ProductionSession | null {
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
function applicablePreview(state: SimulatorState): ProductionReady | null {
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
function reviewablePreview(state: SimulatorState): ProductionReady | null {
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

type ProductionDraftView = Omit<BakerySurfaceProductionDraft, "digest">;

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
function productionDraftMaterial(session: ProductionSession): string | null {
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

// Commits through the workspace's own actions while the draft is unchanged.
function commitProductionCommand(
  state: SimulatorState,
  prepared: Variant<
    PreparedBakerySurfaceCommand,
    | "production_replacement"
    | "production_draft"
    | "production_preview"
    | "production_apply"
  >,
): BakerySurfaceCommandTransition {
  const session = authorableProduction(state);
  if (
    session === null ||
    productionDraftMaterial(session) !== prepared.material
  )
    return rejectedCommand(
      prepared.command.kind,
      "stale_draft",
      "The production draft changed before the command could be applied.",
    );
  let next: SimulatorState;
  switch (prepared.kind) {
    case "production_replacement":
      next = applyBakeryWorkspaceAction(
        { kind: "productionReplacementPrepared", review: prepared.review },
        state,
      );
      break;
    case "production_draft": {
      const result = editProductionDraft(session, prepared.edit);
      if (result.kind === "rejected")
        return rejectedCommand(
          prepared.command.kind,
          "invalid_edit",
          result.message,
        );
      next = applyBakeryWorkspaceAction(
        { kind: "productionDraftEdited", edit: prepared.edit },
        state,
      );
      break;
    }
    case "production_preview":
      next = applyBakeryWorkspaceAction(
        { kind: "productionPreviewed", preview: prepared.preview },
        state,
      );
      break;
    case "production_apply":
      next =
        applicablePreview(state) === prepared.preview
          ? applyBakeryWorkspaceAction(
              {
                kind: "productionPreviewApplied",
                preview: prepared.preview,
              },
              state,
            )
          : state;
      break;
  }
  return next === state
    ? rejectedCommand(
        prepared.command.kind,
        "stale_surface",
        "The production run changed before the command could be applied.",
      )
    : { kind: "applied", state: next };
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
function hasId(id: string, item: { readonly id: string }): boolean {
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

function shiftLayout(): BakerySurfaceShiftLayout | null {
  return shiftFloorPlan?.() ?? null;
}

function shiftLayoutField(): Readonly<{ layout?: BakerySurfaceShiftLayout }> {
  const layout = shiftLayout();
  return layout === null ? {} : { layout };
}

// The checks of Rotate 90°: equipment the floor plan can turn, still at the
// rotation the agent saw.
function equipmentRotationRejected(
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

function equipmentMoveRejected(
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

function equipmentAngleRejected(
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

function floorPlanResetRejected(
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

function openingToggleRejected(
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

function matchingProposal(
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

async function bakerySurfaceDraftReference(
  state: SimulatorState,
  digest: SurfaceDigest = sha256Hex,
): Promise<BakerySurfaceDraftReference> {
  return {
    revision: state.scenario.draftRevision,
    digest: await digest(bakerySurfaceDraftMaterial(state)),
  };
}

function bakerySurfaceDraftMaterial(state: SimulatorState): string {
  const assumptions = [...state.scenario.assumptionDraft.entries()].sort(
    compareDraftEntries,
  );
  return JSON.stringify({
    source: state.run.shift.kind,
    settings: normalSettings(state),
    assumptions,
  });
}

function normalSettings(
  state: SimulatorState,
): Readonly<Record<string, number>> {
  return activeRun({
    ...state,
    run: { ...state.run, variant: "normal" },
  }).settings;
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

function staleSurface(
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

function shiftTaskDetail(
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

function runPreview(run: Run): BakerySurfaceRunPreview {
  const result = metrics(run);
  return {
    state: run.kind,
    endSeconds: run.end,
    lateBatches: result.late,
    unfinishedBatches: result.unfinished,
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

function shiftSelection(
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

function rejectedCommand(
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

function comparisonSource(state: SimulatorState): Run | null {
  if (state.workspace.kind !== "production") return null;
  const session = state.workspace.production;
  if (session.reading || session.data.kind !== "ready") return null;
  return session.preview?.run ?? session.data.run;
}

async function productionComparison(
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

async function inspectWorkspaceRunSave(
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

async function inspectScenarioSave(
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
