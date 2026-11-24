import type { WorkflowChange } from "@purin-labs/bakery-workflow/changes";
import type {
  BakeryFileAction,
  BakeryFloorPlanResetAction,
  BakeryPlaybackAction,
  BakeryProductionControl,
  BakeryProductionEdit,
  BakeryProductionPanel,
  BakeryRecordingAcceptanceReference,
  BakeryRehearsalEdit,
  BakeryStoreInteriorAction,
  BakerySurfaceDraftReference,
  BakerySurfaceEditOperation,
  BakerySurfaceReceiptV1,
  BakerySurfaceSelectionTarget,
  BakeryWorkcellPreparation,
  BakeryWorkspaceViewAction,
} from "@purin-labs/bakery-model/bakery-surface";
import type { PageViewCommand } from "@purin-labs/control-api";
import type {
  BakeStockLevelInput,
  RecipeItem,
} from "@purin-labs/kitchen-control-api";
import type {
  AgentRunSaveVerification,
  AgentScenarioSaveResult,
  SavedBakeryRunQuery,
  SavedBakeryRunResult,
} from "../../contract/saved-bakery-runs";
import type { RecipeDraft } from "../../contract/recipe-draft";
import type {
  WorkflowCanvasMoveTool,
  WorkflowCanvasReadTool,
} from "../../contract/workflow-canvas";
import type { CatalogExecutionContext } from "@purin-labs/agent-tools/catalog/execute";
import { defineToolFamily } from "@purin-labs/agent-tools/define-tool";
import { ToolRequestError } from "@purin-labs/agent-tools/errors";
import type {
  CostsPlanSaveTool,
  CostsReadTool,
  CostsSheetEditTool,
  LotCostSaveTool,
  SupplyCostSaveTool,
} from "../../contract/costs-tools";
import type { PreparedEffect } from "@purin-labs/agent-tools/tool-effect";
import type { CommerceToolReads } from "@purin-labs/area-commerce-contract/server/tool-reads";
import type { SessionToolContext } from "@purin-labs/agent/agent-tools/context";

/** The bake stock level that a person or the agent sets, for the drafts of another area. */
export type { BakeStockLevelInput } from "@purin-labs/kitchen-control-api";

export type HarnessBakerySurfaceToolRequest =
  | Readonly<{ kind: "file_action"; action: BakeryFileAction }>
  | Readonly<{ kind: "inspect_scenario_save" }>
  | Readonly<{ kind: "inspect_run_save"; runKind: "rehearsal" | "production" }>
  | Readonly<{
      kind: "control_workspace_view";
      action: BakeryWorkspaceViewAction;
    }>
  | Readonly<{ kind: "stop_simulation" }>
  | Readonly<{ kind: "discard_candidate" }>
  | Readonly<{
      kind: "prepare_workcell";
      preparation: BakeryWorkcellPreparation;
    }>
  | Readonly<{ kind: "show_production_panel"; panel: BakeryProductionPanel }>
  | Readonly<{ kind: "control_baseline"; action: "pin" | "clear" }>
  | Readonly<{ kind: "control_playback"; action: BakeryPlaybackAction }>
  | Readonly<{
      kind: "prepare_layout";
      baseModelHash: string;
      xMm: number;
      yMm: number;
    }>
  | Readonly<{
      kind: "prepare_production_control";
      control: BakeryProductionControl;
    }>
  | Readonly<{ kind: "inspect_surface" }>
  | Readonly<{ kind: "read_draft" }>
  | Readonly<{
      kind: "query_tasks";
      text: string;
      limit: number;
    }>
  | Readonly<{
      kind: "set_view";
      selection: BakerySurfaceSelectionTarget;
      cursorSeconds: number;
    }>
  | Readonly<{
      kind: "prepare_edit" | "run_shift";
      baseDraft: BakerySurfaceDraftReference;
      edits: readonly BakerySurfaceEditOperation[];
    }>
  | Readonly<{
      kind: "select_item";
      selection: Exclude<BakerySurfaceSelectionTarget, { kind: "operation" }>;
    }>
  | Readonly<{ kind: "rotate_equipment"; applianceId: string }>
  | Readonly<{
      kind: "set_equipment_angle";
      applianceId: string;
      yawDegrees: number;
    }>
  | Readonly<{
      kind: "move_equipment";
      applianceId: string;
      xMm: number;
      zMm: number;
    }>
  | Readonly<{
      kind: "toggle_opening";
      openingId: string;
      open: boolean;
    }>
  | Readonly<{
      kind: "select_floor_plan";
      floorPlan: string;
    }>
  | Readonly<{
      kind: "configure_interior";
      action: BakeryStoreInteriorAction;
    }>
  | Readonly<{
      kind: "reset_floor_plan";
      action: BakeryFloorPlanResetAction;
    }>
  | Readonly<{ kind: "compare_shift"; mode: "normal" | "outage" }>
  | Readonly<{ kind: "start_production"; preset: "procedure" | "one-batch" }>
  | Readonly<{
      kind: "list_saved_runs";
      runKind: "rehearsal" | "production";
      cursor: string | null;
    }>
  | Readonly<{ kind: "prepare_run_save"; name: string }>
  | Readonly<{
      kind: "prepare_run_open";
      runKind: "rehearsal" | "production";
      id: string;
    }>
  | Readonly<{ kind: "prepare_scenario_save"; name: string; note: string }>
  | Readonly<{
      kind: "simulate_workcell";
      mode: "transfer" | "oven-cycle" | "rack-cycle";
    }>
  | Readonly<{
      kind: "accept_candidate";
      candidate: BakeryRecordingAcceptanceReference;
    }>
  | Readonly<{ kind: "edit_rehearsal"; edit: BakeryRehearsalEdit }>
  | Readonly<{ kind: "edit_production"; edit: BakeryProductionEdit }>
  | Readonly<{ kind: "preview_production" }>
  | Readonly<{ kind: "apply_production" }>;

export type HarnessBakerySurfaceToolResult = Readonly<{
  receiptId: string;
  receipt: BakerySurfaceReceiptV1;
  saveVerification: AgentRunSaveVerification;
  scenarioSaveResult: AgentScenarioSaveResult;
}>;

export class BakeryContextRequestError extends ToolRequestError {}

type HarnessBakerySurfaceExecute = (
  request: HarnessBakerySurfaceToolRequest,
  callId: string,
) => Promise<HarnessBakerySurfaceToolResult>;

type RecipeReadTool = () => Promise<RecipeToolRead>;

export type RecipeToolRead = Readonly<{
  recipes: readonly Readonly<{
    recipeId: string;
    revision: number;
    name: string;
    inputs: RecipeDraft["inputs"];
    output: RecipeDraft["output"];
    state: string;
  }>[];
  items: readonly RecipeItem[];
}>;

/** A null recipe id means a new recipe. */
export type RecipeSaveRequest = Omit<RecipeDraft, "recipeId"> &
  Readonly<{ recipeId: string | null }>;

type RecipeSaveTool = (
  request: RecipeSaveRequest,
  operationId: string,
) => Promise<PreparedEffect>;

export type SupplierToolRead = Readonly<{
  suppliers: readonly Readonly<{
    supplierId: string;
    name: string;
    leadTimeDays: number | null;
    contactName: string | null;
    email: string | null;
    phone: string | null;
    minimumOrderQuantity: string | null;
    minimumOrderUnit: string | null;
    purchasingNotes: string | null;
  }>[];
  /** More suppliers than this read returns. */
  more: boolean;
}>;

type SupplierReadTool = () => Promise<SupplierToolRead>;

/** One field of the Add supplier form. */
export type SupplierCreateField =
  | "displayName"
  | "legalName"
  | "countryCode"
  | "contactName"
  | "email"
  | "phone"
  | "leadTimeDays"
  | "minimumOrderQuantity"
  | "minimumOrderUnit"
  | "purchasingNotes"
  | "inventoryItemIds";

/** The fields of the Add supplier form. The name gives the supplier's id. */
export type SupplierCreateRequest = Readonly<
  Record<SupplierCreateField, unknown>
>;

type SupplierCreateTool = (
  request: SupplierCreateRequest,
  operationId: string,
) => Promise<PreparedEffect>;

export type RecipeWorkflowReadRequest = Readonly<{ workflowId: string | null }>;

type RecipeWorkflowReadTool = (
  request: RecipeWorkflowReadRequest,
) => Promise<unknown>;

export type RecipeWorkflowProposeRequest = Readonly<{
  workflowId: string;
  baseDigest: string;
  changes: readonly WorkflowChange[];
  reason: string;
  findingIds: readonly string[];
}>;

type RecipeWorkflowProposeTool = (
  request: RecipeWorkflowProposeRequest,
  operationId: string,
) => Promise<unknown>;

/** A recipe workflow request that was refused, in words that the agent can act on. */
export class RecipeWorkflowRequestError extends ToolRequestError {}

/**
 * Plan 40D: one location's shared production plan. The requests come from
 * Commerce; the planned quantities are the shared draft that people edit
 * too. A person accepts the plan.
 */
export type HarnessProductionPlanRead = Readonly<{
  readonly locationId: string;
}>;

export type HarnessProductionPlanEdit = HarnessProductionPlanRead &
  Readonly<{ readonly requestId: string; readonly quantity: string }>;

export type HarnessProductionPlan = Readonly<{
  readonly locationId: string;
  /** The location's requests that wait for acceptance. */
  readonly requests: readonly Readonly<{
    readonly requestId: string;
    readonly inventoryItemId: string;
    /** The item's name, as the same read returns it; null when it is absent. */
    readonly itemName: string | null;
    readonly recipeId: string;
    readonly requestedQuantity: string;
    readonly unit: string;
    readonly neededBy: string;
    /** The plan's draft quantity, or null when the plan keeps the request's. */
    readonly plannedQuantity: string | null;
  }>[];
  /** True when the location has more waiting requests than this read shows. */
  readonly truncated: boolean;
}>;

type ProductionPlanReadTool = (
  request: HarnessProductionPlanRead,
) => Promise<HarnessProductionPlan>;

type ProductionPlanEditTool = (
  request: HarnessProductionPlanEdit,
  operationId: string,
  boundary: CatalogExecutionContext,
) => Promise<PreparedEffect>;

/**
 * Plan 40D: a plan request that the model can correct, such as a request that
 * no longer waits for acceptance. Its message reaches the model.
 */
export class ProductionPlanRequestError extends ToolRequestError {}

/**
 * A view command of a Portal page (Plan 87 phase 4). It runs in the person's
 * browser as their own click does and saves nothing. The result is what the
 * page shows after the command.
 */
export type PageViewExecute = (
  command: PageViewCommand,
  callId: string,
) => Promise<unknown>;

/** Plan 24 S1: a bake that the agent proposes; a person decides it. */
export type BakeProposeRequest = Readonly<{
  inventoryItemId: string;
  /** The pieces to bake; null bakes the shortfall below the level. */
  pieces: number | null;
}>;

type BakeReadTool = () => Promise<unknown>;
type BakeProposeTool = (request: BakeProposeRequest) => Promise<unknown>;
type BakeStockLevelProposeTool = (
  request: BakeStockLevelInput,
) => Promise<unknown>;

/** Plan 24 S4: one proposal's bake run, for its read or a pause request. */
export type BakeRunRequest = Readonly<{ proposalId: string }>;
type BakeRunReadTool = (request: BakeRunRequest) => Promise<unknown>;
type BakeRunPauseTool = (
  request: BakeRunRequest,
  operationId: string,
) => Promise<PreparedEffect>;

/** A bake request that was refused, in words that the agent can act on. */
export class BakeRequestError extends ToolRequestError {}

/** What a turn gives to the Kitchen tools. */
export type KitchenToolServices = {
  readonly readSavedBakeryRun: (
    query: SavedBakeryRunQuery,
  ) => Promise<SavedBakeryRunResult>;
  readonly executeBakerySurface: HarnessBakerySurfaceExecute;
  /** Runs the view commands of Costs & margins and of the Pastry Bench. */
  readonly executePageViewCommand?: PageViewExecute;
  readonly readRecipes: RecipeReadTool;
  readonly saveRecipe: RecipeSaveTool;
  readonly readCosts: CostsReadTool;
  readonly saveSupplyCost: SupplyCostSaveTool;
  readonly saveLotCost?: LotCostSaveTool;
  readonly saveCostsPlan: CostsPlanSaveTool;
  readonly editCostsSheet: CostsSheetEditTool;
  readonly readSuppliers: SupplierReadTool;
  readonly createSupplier: SupplierCreateTool;
  readonly readRecipeWorkflow: RecipeWorkflowReadTool;
  readonly proposeRecipeWorkflow: RecipeWorkflowProposeTool;
  readonly readProductionPlan?: ProductionPlanReadTool;
  readonly editProductionPlan?: ProductionPlanEditTool;
  readonly readWorkflowCanvas: WorkflowCanvasReadTool;
  readonly moveWorkflowCanvasObject: WorkflowCanvasMoveTool;
  readonly readBakes: BakeReadTool;
  readonly proposeBake: BakeProposeTool;
  readonly proposeBakeStockLevel: BakeStockLevelProposeTool;
  readonly readBakeRun: BakeRunReadTool;
  readonly pauseBakeRun: BakeRunPauseTool;
};

export const defineKitchenTool =
  defineToolFamily<KitchenToolServices>()("kitchen");

/**
 * The turn context of a Kitchen tool handler: the authority of the turn and
 * the commerce reads. The Worker gives the commerce reads.
 */
export interface KitchenToolContext extends SessionToolContext {
  readonly commerce: CommerceToolReads;
}
