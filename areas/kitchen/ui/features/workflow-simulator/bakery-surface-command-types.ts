import type { BakeryExportFile } from "./production-files.ts";
import type { ProductionPending } from "./production-session.ts";
import type { ScenarioRead } from "./scenario-api.ts";
import type { RunSnapshotPage } from "@purin-labs/bakery-model/bakery-run-snapshot";
import type { ProductionNavigation } from "./production-navigation.ts";
import type { PreparedProductionReplacement } from "./production-draft.ts";
import type { PreparedRehearsalReview } from "./rehearsal-edits.ts";
import type { PreparedWorkcell } from "./workcell-preparation.ts";
import type { RackLayoutProposal } from "./rack-layout.ts";
import type {
  BakeryRunSaveInspection,
  BakeryScenarioSaveInspection,
  BakeryFileManifest,
} from "@purin-labs/bakery-model/bakery-surface";
import type {
  ProductionReady,
  ProductionSession,
} from "./production-session.ts";
import type {
  PreparedProductionPreview,
  ProductionDraftEdit,
} from "./production-draft.ts";
import type { PreparedRehearsalEdit } from "./rehearsal-edits.ts";
import type {
  RejectedBakerySurfaceCommandResultV1,
  BakerySurfaceCommandV1,
  BakerySurfaceDraftReference,
  BakerySurfaceEditProposalV1,
  BakerySurfaceProductionDraft,
  BakerySurfaceTaskDetail,
} from "@purin-labs/bakery-model/bakery-surface";
import type { RecordingNavigation } from "@purin-labs/production-simulation/simulator/playback-state";
import type { Settings } from "@purin-labs/bakery-model/bakery";
import type { Run } from "@purin-labs/production-simulation/recipes/bakery/schedule";
import type {
  RecordingAcceptanceTarget,
  PreparedRecordingAcceptance,
  SimulatorShift,
  SimulatorState,
  WorkspaceRunSaveStatus,
} from "./simulator-state.ts";
import type { Selection } from "@purin-labs/production-simulation/simulator/selection";
import type { PreparedWorkspaceRun } from "./workspace-runs-api.ts";
import type { WorkspaceRunReview } from "./workspace-run-review.ts";
import type { ProductionScenarioRead } from "./production-scenario-api";
import type {
  AgentScenarioSavePayload,
  AgentScenarioSaveManifest,
} from "@purin-labs/bakery-model/bakery-agent-scenario-save";
import type { Variant } from "@purin-labs/type-utils";

export type BakerySurfaceCommandTransition =
  | Readonly<{ kind: "applied"; state: SimulatorState }>
  | RejectedBakerySurfaceCommandResultV1;

export type BakerySurfaceCommandOrigin =
  | Readonly<{ kind: "local" }>
  | Readonly<{ kind: "agent_effect"; effectId: string }>;

export type SurfaceDigest = (value: string) => Promise<string>;

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

export type ScheduledSession = ProductionSession &
  Readonly<{
    data: Variant<ProductionSession["data"], "ready">;
  }>;

export type ProductionDraftView = Omit<BakerySurfaceProductionDraft, "digest">;
