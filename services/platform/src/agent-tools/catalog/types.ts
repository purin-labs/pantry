import type { OrderRefundLineRequest } from "../../commerce/order-refund-action";
import type { MenuBoardLayout, MenuBoardStart } from "@purin-labs/menu-board-crdt";
import type { StockProposalRequest } from "../../commerce/stock-action-plan";
import type { WorkflowChange } from "@purin-labs/bakery-workflow/changes";
import type { BakeryProductionControl } from "@purin-labs/bakery-model/bakery-surface";
import type { SUPPLIER_CREATE_FIELDS } from "../kitchen/suppliers";
import type { EmailReplyCitation } from "../../mail-inbox/reply-sources";
import type {
  OrderQueueAction,
  OrderQueueEntry,
  RecipeItem,
  SoldOutItem,
} from "@purin-labs/control-api";
import type {
  CostsPlanSaveRequest,
  CostsPlanSaveTool,
  CostsReadRequest,
  CostsReadTarget,
  CostsReadTool,
  CostsSheetEditRequest,
  CostsSheetEditResult,
  CostsSheetEditTool,
  CostsToolRead,
  LotCostSaveRequest,
  LotCostSaveTool,
  SupplyCostSaveRequest,
  SupplyCostSaveTool,
} from "../kitchen/costs";
import type {
  JevFeatureCommand,
  JevFeaturesView,
} from "@purin-labs/control-api/portal/jev-features";
import type { SoldOutMark } from "../../commerce/order-queue-commands";
import type { PaymentsToolRead } from "../../commerce/payments-read";
import type { RecipeDraft } from "../../commerce/recipe-commands";
import type {
  BakeryFileAction,
  BakeryFloorPlanResetAction,
  BakeryStoreInteriorAction,
} from "@purin-labs/bakery-model/bakery-surface";
import type { HarnessNativeCodeMode } from "../../actors/embedded-harness";
import type { IntegrationAccountReference } from "../../access-control/integration-discovery";
import type { CommerceActionRequest } from "../../commerce/action-model";
import type {
  CodeModeExecutionOutcome,
  IntegrationDiscoveryView,
  CommerceContextRequest,
  CommerceGraphQueryResult,
} from "@purin-labs/contracts";
import type { Result } from "../../result";
import type { AuthorizedHarnessToolResult } from "@purin-labs/contracts";
import type {
  BakeryWorkspaceViewAction,
  BakeryProductionPanel,
  BakeryWorkcellPreparation,
  BakeryPlaybackAction,
  BakerySurfaceDraftReference,
  BakerySurfaceEditOperation,
  BakerySurfaceReceiptV1,
  BakerySurfaceSelectionTarget,
  BakeryRecordingAcceptanceReference,
  BakeryRehearsalEdit,
  BakeryProductionEdit,
} from "@purin-labs/bakery-model/bakery-surface";
import type { AgentRunSaveVerification } from "../../commerce/bakery/agent-run-save";
import type { AgentScenarioSaveResult } from "../../commerce/bakery/agent-scenario-save";
import type {
  DraftAgentEditRequest,
  DraftAgentReadArgs,
  DraftAgentSnapshot,
} from "../../actors/product-description-draft";
import type {
  EmailDraftEditRequest,
  EmailDraftRead,
} from "../../actors/email-draft";
import type { MenuDraftEdit, MenuDraftRead } from "../../actors/menu-draft";
import type {
  MenuBoardEdit,
  MenuBoardEditResult,
} from "../../actors/menu-boards";
import type { MenuPriceProposalRequest } from "../../actors/harness-commerce-proposal";
import type {
  MerchantReportName,
  MerchantReportResult,
} from "../../commerce/entity-plane/merchant-reports";
import type {
  CanonicalFileReference,
  FileReadToolResult,
  FileSearchToolResult,
} from "../../context/files";
import type { EmailSelfTestRequest } from "../../data/email-self-test";
import { CAPABILITY_KEYS } from "../../authorization/capability-catalogue";
import type {
  CustomConnectorCatalogEntry,
  CustomConnectorReadCatalogEntry,
  CustomConnectorWriteCatalogEntry,
} from "../../custom-connectors";
import type { MerchantPluginDraft } from "../../commerce/merchant-plugin-action";
import type { CatalogExecutionContext } from "./execute";
import type { JsonSchema } from "./selection";

export type HarnessToolDefinition = {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly strict: true;
  readonly parameters: JsonSchema;
};

export type HarnessCodeModeAuthority = {
  readonly mode: "hybrid";
  readonly catalogDigest: string;
  readonly definitions: readonly HarnessToolDefinition[];
  readonly codeMode: HarnessNativeCodeMode;
  readonly claimCapability: HarnessCapabilityClaim;
  executeTool(
    name: string,
    inputJson: string,
    callId: string,
  ): Promise<AuthorizedHarnessToolResult>;
};

export type HarnessCatalogSelection = {
  readonly allowedCapabilities: readonly HarnessCapabilityName[];
  readonly customConnectorOperations?: readonly CustomConnectorCatalogEntry[];
  /** The Kitchen and Costs commands that the turn offers (Plan 87). */
  readonly bakerySurfaceCommands?: readonly import("../define-tool").SurfaceToolCommandName[];
  /** True for a turn that may propose a Memory from a person's message. */
  readonly memoryProposal?: boolean;
  /** True for a Slack thread turn, which may schedule a follow-up turn. */
  readonly followUp?: boolean;
  /**
   * True for a Portal chat turn or a Slack thread turn, which may propose a
   * side Case (Plan 74).
   */
  readonly sideCaseProposal?: boolean;
  /**
   * True for a Slack thread or Portal chat turn, which may ask a person for
   * a capability it lacks.
   */
  readonly permissionRequest?: boolean;
};

/** What the agent states when it proposes a Memory from a chat message. */
export type HarnessMemoryProposalRequest = Readonly<{
  statement: string;
  memoryKind: "fact" | "preference";
}>;

export type HarnessMemoryProposalResult =
  | Readonly<{
      kind: "memory_proposed";
      state: "waiting_for_review";
      detail: string;
      reason?: never;
    }>
  | Readonly<{
      kind: "memory_not_proposed";
      reason: string;
      state?: never;
      detail?: never;
    }>;

export type HarnessMemoryProposal = (
  request: HarnessMemoryProposalRequest,
) => Promise<HarnessMemoryProposalResult>;

/** When to come back to a Slack thread, and what to do then. */
export type HarnessFollowUpRequest = Readonly<{
  afterMinutes: number;
  note: string;
}>;

export type HarnessFollowUpResult =
  | Readonly<{
      kind: "follow_up_scheduled";
      dueAt: string;
      afterMinutes: number;
      detail: string;
      reason?: never;
    }>
  | Readonly<{
      kind: "follow_up_not_scheduled";
      reason: string;
      dueAt?: never;
      afterMinutes?: never;
      detail?: never;
    }>;

export type HarnessFollowUpSchedule = (
  request: HarnessFollowUpRequest,
) => Promise<HarnessFollowUpResult>;

/** Separate work that the agent proposes as a side Case (Plan 74). */
export type HarnessSideCaseProposalRequest = Readonly<{
  title: string;
  brief: string;
}>;

export type HarnessSideCaseProposalResult =
  | Readonly<{
      kind: "side_case_proposed";
      detail: string;
      reason?: never;
    }>
  | Readonly<{
      kind: "side_case_not_proposed";
      reason: string;
      detail?: never;
    }>;

export type HarnessSideCaseProposal = (
  request: HarnessSideCaseProposalRequest,
) => Promise<HarnessSideCaseProposalResult>;

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

export class BakeryContextRequestError extends Error {}

/**
 * A Slack draft the model can correct, such as one for a channel that is not
 * connected. Its message reaches the model, so it names no channel or account.
 */
export class SlackDraftRequestError extends Error {}

/**
 * Plan 40D: a reply draft request the model can correct, such as a read from
 * a chat that did not read the reply's sources. Its message reaches the
 * model, so it names no source, Project, person or reply text.
 */
export class EmailReplyDraftRequestError extends Error {}

/** The exit check stopped a tool effect, and Pantry asked a person (Plan 27C). */
export class ExitApprovalRequestedError extends Error {}

export type HarnessBakerySurfaceExecute = (
  request: HarnessBakerySurfaceToolRequest,
  callId: string,
) => Promise<HarnessBakerySurfaceToolResult>;

export type HarnessCapabilityName =
  | typeof CAPABILITY_KEYS.airtableApiRead
  | typeof CAPABILITY_KEYS.airtableApiWrite
  | typeof CAPABILITY_KEYS.integrationDiscoveryRead
  | typeof CAPABILITY_KEYS.emailMailboxRead
  | typeof CAPABILITY_KEYS.emailReplyPropose
  | typeof CAPABILITY_KEYS.emailOperationalPropose
  | typeof CAPABILITY_KEYS.slackMessagePropose
  | typeof CAPABILITY_KEYS.whatsappSupportRead
  | typeof CAPABILITY_KEYS.whatsappSupportReplySend
  | typeof CAPABILITY_KEYS.commerceEntityPlaneContext
  | typeof CAPABILITY_KEYS.commerceWorkflowCanvasMove
  | typeof CAPABILITY_KEYS.commerceProductDescriptionDraftEdit
  | typeof CAPABILITY_KEYS.commerceMenuDraftRead
  | typeof CAPABILITY_KEYS.commerceMenuDraftEdit
  | typeof CAPABILITY_KEYS.commerceProductionPlanEdit
  | typeof CAPABILITY_KEYS.commerceOrderQueueAdvance
  | typeof CAPABILITY_KEYS.commerceSoldOutMark
  | typeof CAPABILITY_KEYS.commerceRecipeSave
  | typeof CAPABILITY_KEYS.commerceSupplyCostSave
  | typeof CAPABILITY_KEYS.commerceSupplierCreate
  | typeof CAPABILITY_KEYS.deviceRead
  | typeof CAPABILITY_KEYS.devicePause
  | typeof CAPABILITY_KEYS.recipeWorkflowRead
  | typeof CAPABILITY_KEYS.recipeWorkflowPropose
  | typeof CAPABILITY_KEYS.deviceCameraRead
  | typeof CAPABILITY_KEYS.jevFeaturesRead
  | typeof CAPABILITY_KEYS.jevFeaturesManage
  | typeof CAPABILITY_KEYS.marketingEmailDraftEdit
  | typeof CAPABILITY_KEYS.commerceActionPropose
  | typeof CAPABILITY_KEYS.fileRead
  | typeof CAPABILITY_KEYS.messageAttachmentInspect
  | typeof CAPABILITY_KEYS.messageLinkRead
  | typeof CAPABILITY_KEYS.customConnectorRead
  | typeof CAPABILITY_KEYS.customConnectorWrite
  | typeof CAPABILITY_KEYS.workspaceQuery;

/** The tool call a proposal comes from, as the accepted history names it. */
export type CommerceActionProposalOrigin = Readonly<{ toolCallId: string }>;

export type CommerceActionProposal = (
  request: CommerceActionRequest,
  origin?: CommerceActionProposalOrigin,
) => Promise<unknown>;

export type MerchantPluginProposal = (
  draft: MerchantPluginDraft,
  origin?: CommerceActionProposalOrigin,
) => Promise<unknown>;

export type ProductDescriptionDraftRead = (
  request: DraftAgentReadArgs,
) => Promise<DraftAgentSnapshot>;

export type ProductDescriptionDraftEdit = (
  request: DraftAgentEditRequest,
  operationId: string,
  boundary: CatalogExecutionContext,
) => Promise<DraftAgentSnapshot>;

export type OrderQueueReadTool = () => Promise<OrderQueueToolRead>;

export type CounterSaleReadRequest = Readonly<{ checkoutId: string }>;

export type CounterSaleToolRead = Readonly<{
  checkoutId: string;
  satyrLocationId: string;
  state: string;
  collectable: boolean;
  orderId: string | null;
  pickupCode: string | null;
  paymentMethod: string | null;
  tenderBrand: string | null;
  providerRefundable: boolean | null;
  amountMinor: number | null;
  currency: string | null;
  cashReceivedMinor: number | null;
  changeDueMinor: number | null;
  afterSale: Readonly<{
    orderState: string;
    paymentState: string;
    fulfillmentState: string;
    refundState: string;
  }> | null;
}>;

export type CounterSaleReadTool = (
  request: CounterSaleReadRequest,
) => Promise<CounterSaleToolRead>;

/** The window of a payments read: two UTC instants, the start first. */
export type PaymentsReadRequest = Readonly<{ start: string; end: string }>;

export type PaymentsReadTool = (
  request: PaymentsReadRequest,
) => Promise<PaymentsToolRead>;

export type OrderQueueToolRead = Readonly<{
  entries: readonly OrderQueueEntry[];
}>;

export type OrderQueueAdvanceRequest = Readonly<{
  fulfillmentId: string;
  action: OrderQueueAction;
}>;

export type StaffPageToolReceipt = Readonly<{
  receiptId: string;
  result: string;
}>;

export type OrderQueueAdvanceTool = (
  request: OrderQueueAdvanceRequest,
  operationId: string,
) => Promise<StaffPageToolReceipt>;

export type SoldOutReadTool = () => Promise<SoldOutToolRead>;

export type SoldOutToolRead = Readonly<{ items: readonly SoldOutItem[] }>;

export type SoldOutMarkRequest = Readonly<{
  variantId: string;
  mark: SoldOutMark;
}>;

export type SoldOutMarkTool = (
  request: SoldOutMarkRequest,
  operationId: string,
) => Promise<StaffPageToolReceipt>;

export type RecipeReadTool = () => Promise<RecipeToolRead>;

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

export type RecipeSaveTool = (
  request: RecipeSaveRequest,
  operationId: string,
) => Promise<StaffPageToolReceipt>;

export type {
  CostsPlanSaveRequest,
  CostsPlanSaveTool,
  CostsReadRequest,
  CostsReadTarget,
  CostsReadTool,
  CostsSheetEditRequest,
  CostsSheetEditResult,
  CostsSheetEditTool,
  CostsToolRead,
  LotCostSaveRequest,
  LotCostSaveTool,
  SupplyCostSaveRequest,
  SupplyCostSaveTool,
};

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

export type SupplierReadTool = () => Promise<SupplierToolRead>;

/** The fields of the Add supplier form. The name gives the supplier's id. */
export type SupplierCreateRequest = Readonly<
  Record<(typeof SUPPLIER_CREATE_FIELDS)[number], unknown>
>;

export type SupplierCreateTool = (
  request: SupplierCreateRequest,
  operationId: string,
) => Promise<StaffPageToolReceipt>;

export type RecipeWorkflowReadRequest = Readonly<{ workflowId: string | null }>;

export type RecipeWorkflowReadTool = (
  request: RecipeWorkflowReadRequest,
) => Promise<unknown>;

export type RecipeWorkflowProposeRequest = Readonly<{
  workflowId: string;
  baseDigest: string;
  changes: readonly WorkflowChange[];
  reason: string;
  findingIds: readonly string[];
}>;

export type RecipeWorkflowProposeTool = (
  request: RecipeWorkflowProposeRequest,
  operationId: string,
) => Promise<unknown>;

/** A recipe workflow request that was refused, in words that the agent can act on. */
export class RecipeWorkflowRequestError extends Error {}

export type DeviceReadTool = () => Promise<DeviceToolRead>;

export type DeviceToolRead = Readonly<{
  gateways: readonly Readonly<Record<string, unknown>>[];
  devices: readonly Readonly<Record<string, unknown>>[];
  shopMacs: readonly Readonly<Record<string, unknown>>[];
}>;

export type DeviceSnapshotReadTool = () => Promise<
  Readonly<{
    snapshotsEnabled: boolean;
    snapshots: readonly Readonly<Record<string, unknown>>[];
  }>
>;

export type DevicePauseRequest = Readonly<{ deviceId: string }>;

export type DevicePauseTool = (
  request: DevicePauseRequest,
  operationId: string,
) => Promise<StaffPageToolReceipt>;

export type DeviceProposeRequest = Readonly<{
  deviceId: string;
  action: "restrict" | "resume";
  reason: string | null;
}>;

export type DeviceProposeTool = (
  request: DeviceProposeRequest,
) => Promise<unknown>;

/** A device request that was refused, in words that the agent can act on. */
export class DeviceRequestError extends Error {}

/** The Jev settings, as Settings › Jev shows them (Plan 88). */
export type JevFeaturesReadTool = () => Promise<JevFeaturesView>;

/** Turns one Jev switch on or off, after a person approves the card. */
export type JevFeatureProposeTool = (
  request: JevFeatureCommand,
) => Promise<unknown>;

/** A Jev request that was refused, in words that the agent can act on. */
export class JevFeatureRequestError extends Error {}

/**
 * A step of a staff page that was refused, in words that the agent can act on.
 * It names no buyer.
 */
export class StaffPageRequestError extends Error {}

export type MenuDraftReadTool = () => Promise<MenuDraftRead>;

export type MenuDraftEditTool = (
  edit: MenuDraftEdit,
  operationId: string,
  boundary: CatalogExecutionContext,
) => Promise<MenuDraftRead>;

/** Plan 40B phase 4: the shop's boards and the live prices of their items. */
export type MenuBoardReadTool = (
  request: Readonly<{ boardId: string | null }>,
) => Promise<unknown>;

export type MenuBoardEditTool = (
  request: Readonly<{ boardId: string; edit: MenuBoardEdit }>,
  operationId: string,
  boundary: CatalogExecutionContext,
) => Promise<MenuBoardEditResult>;

/** Plan 40B, the start screen: a new board from a layout or a design. */
export type MenuBoardCreateRequest = Readonly<{
  title: string;
  layout: MenuBoardLayout;
  start: MenuBoardStart;
}>;

export type MenuBoardCreateTool = (
  request: MenuBoardCreateRequest,
  operationId: string,
  boundary: CatalogExecutionContext,
) => Promise<unknown>;

/** Plan 40B, board removal: archive a board or restore an archived one. */
export type MenuBoardArchiveRequest = Readonly<{
  boardId: string;
  archived: boolean;
}>;

export type MenuBoardArchiveTool = (
  request: MenuBoardArchiveRequest,
  operationId: string,
  boundary: CatalogExecutionContext,
) => Promise<unknown>;

export type MenuPriceProposal = (
  request: MenuPriceProposalRequest,
  origin?: CommerceActionProposalOrigin,
) => Promise<unknown>;

export type CafeMenuPublicationProposal = (
  request: Readonly<{ documentRevision: number }>,
  origin?: CommerceActionProposalOrigin,
) => Promise<unknown>;

export type OrderRefundProposal = (
  request: Readonly<{
    orderId: string;
    expectedRevision: number;
    reason: string;
    refundLines: readonly OrderRefundLineRequest[] | null;
  }>,
  origin?: CommerceActionProposalOrigin,
) => Promise<unknown>;

export type StockActionProposal = (
  request: StockProposalRequest,
  origin?: CommerceActionProposalOrigin,
) => Promise<unknown>;

export type EmailDraftReadTool = () => Promise<EmailDraftRead>;

export type EmailDraftEditTool = (
  request: EmailDraftEditRequest,
  operationId: string,
  boundary: CatalogExecutionContext,
) => Promise<EmailDraftRead>;

export type HarnessCapabilityClaimInput = {
  readonly callId: string;
  readonly capability: HarnessCapabilityName;
  readonly boundary: "direct_tool" | "code_mode" | "attachment_preparation";
};

export type HarnessCapabilityClaim = (
  input: HarnessCapabilityClaimInput,
) => Promise<
  Result<
    null,
    {
      readonly code: "embedded_harness_capability_claim_rejected";
      readonly detail: string;
    }
  >
>;

export type HarnessCustomConnectorRead = (
  entry: CustomConnectorReadCatalogEntry,
  input: unknown,
  operationId: string,
) => Promise<unknown>;

export type HarnessCustomConnectorWriteProposal = (
  entry: CustomConnectorWriteCatalogEntry,
  input: unknown,
  operationId: string,
) => Promise<unknown>;

export type HarnessCodeModeConstructionError =
  | { readonly code: "embedded_harness_tool_catalog_digest_mismatch" }
  | { readonly code: "embedded_harness_custom_connector_unavailable" }
  | { readonly code: "embedded_harness_surface_unavailable" };

export type HarnessResourceScopeError = {
  readonly code: "embedded_harness_resource_scope_invalid";
  readonly scope: string;
};

export type HarnessCodeModeExecutionLease = {
  readonly executionId: string;
  readonly leaseId: string;
};

/** An execution that the admission holds for the current runtime lease. */
export type HarnessCodeModeAdmittedExecution = HarnessCodeModeExecutionLease & {
  /** The deadline of the first admission. A resumed execution keeps it. */
  readonly executionDeadlineAt: number;
  /**
   * `false` when an earlier process admitted the execution under another
   * catalog or policy. The reservation settles, and no VM starts.
   */
  readonly runnable: boolean;
};

/**
 * Decides whether results with these sources may be read now. It validates
 * current authority for every capability, and it claims no budget.
 */
export type HarnessSourceAuthorization = (
  capabilities: readonly HarnessCapabilityName[],
) => Promise<Result<null, { readonly detail: string }>>;

export type HarnessCodeModeExecutionOutcome = CodeModeExecutionOutcome;

/**
 * A capability claim that a global admission freeze refused. The script that
 * made the call stops: it must not continue on a value that the freeze kept
 * from it.
 */
export class CodeModeAdmissionFrozenError extends Error {
  constructor() {
    super("Code Mode capability claim failed: code_mode_platform_disabled");
    this.name = "CodeModeAdmissionFrozenError";
  }
}

export type HarnessCodeModeAdmission = {
  begin(
    source: string,
    callId: string,
  ): Promise<HarnessCodeModeAdmittedExecution>;
  /** Rejects with `CodeModeAdmissionFrozenError` during an admission freeze. */
  claim(
    lease: HarnessCodeModeExecutionLease,
    callId: string,
    inputBytes: number,
  ): Promise<void>;
  complete(
    lease: HarnessCodeModeExecutionLease,
    callId: string,
    outputBytes: number,
  ): Promise<void>;
  /**
   * Ends the capability calls that an earlier process of this execution left
   * in flight, or that a failed claim or completion left in flight, and takes
   * the counts of the Organisation. It runs only after the calls of this
   * process ended.
   */
  abandon(lease: HarnessCodeModeExecutionLease): Promise<void>;
  settle(
    lease: HarnessCodeModeExecutionLease,
    outcome: HarnessCodeModeExecutionOutcome,
    outputBytes: number,
  ): Promise<void>;
};

export type EntityContextRead = (
  request: CommerceContextRequest,
) => Promise<CommerceGraphQueryResult>;

/** One drafted campaign, staged for review. Nothing here sends or spends. */
export type HarnessCampaignBriefRequest = Readonly<{
  objective: string;
  targets: readonly Readonly<{
    entityType: "product" | "sellable_variant" | "offer";
    entityId: string;
    revision: number;
  }>[];
  channel: string;
  audienceDescription: string;
  messageVariants: readonly Readonly<{
    variantId: string;
    headline: string;
    body: string;
  }>[];
  requestedBudgetMinor: number;
  currency: string;
  windowStart: string;
  windowEnd: string;
  disclosures: readonly string[];
  supportingEvidence: string;
}>;

export type CampaignBriefPropose = (
  request: HarnessCampaignBriefRequest,
) => Promise<unknown>;

/** One proposed configuration change for operator confirmation. */
export type HarnessConfigurationProposalRequest = Readonly<{
  command: unknown;
}>;

export type ConfigurationPropose = (
  request: HarnessConfigurationProposalRequest,
) => Promise<unknown>;

/** One named merchant report; the agent selects a name, never a query. */
export type HarnessMerchantReportRequest = Readonly<{
  name: MerchantReportName;
}>;

export type MerchantReportRead = (
  request: HarnessMerchantReportRequest,
) => Promise<MerchantReportResult>;

export type HarnessIntegrationListRequest = Readonly<{ kind: "list" }>;

export type HarnessWhatsAppSupportRead = Readonly<{
  readonly limit: number;
}>;

export type HarnessEmailMailboxSearch = Readonly<{
  readonly integrationAccountId: string;
  readonly query: string;
  readonly limit: number;
}>;

export type HarnessEmailMailboxSearchResult = Readonly<{
  readonly integrationAccountId: string;
  readonly messages: readonly Readonly<{
    readonly messageId: string;
    readonly threadId: string;
    readonly from: string | null;
    readonly subject: string;
    readonly date: string | null;
    readonly bodyText: string;
    readonly attachments: readonly Readonly<{
      readonly filename: string;
      readonly mimeType: string;
      readonly declaredBytes: number;
    }>[];
  }>[];
  readonly truncated: boolean;
}>;

export type HarnessEmailReplyPropose = Readonly<{
  readonly integrationAccountId: string;
  readonly messageId: string;
  readonly threadId: string;
  readonly body: string;
  /** What the model claims supports the body. Nothing here is verified. */
  readonly citations: readonly EmailReplyCitation[];
  readonly malformedCitations: number;
}>;

export type HarnessEmailReplyProposalReceipt = Readonly<{
  readonly kind: "proposed";
  readonly proposalId: string;
  readonly providerDraftId: string;
}>;

export type HarnessEmailOperationalPropose = Readonly<{
  readonly accountRef: IntegrationAccountReference;
  readonly target:
    | import("../../data/email-operational").OperationalEmailTarget
    | EmailSelfTestRequest;
  readonly subject: string;
  readonly body: string;
}>;

export type HarnessEmailOperationalProposalReceipt = Readonly<{
  readonly kind: "proposed";
  readonly proposalId: string;
  readonly version: number;
  readonly snapshotDigest: string;
}>;

export type HarnessSlackMessagePropose = Readonly<{
  readonly accountRef: IntegrationAccountReference;
  /** A connected channel's name or ID; null lets the person choose. */
  readonly channel: string | null;
  readonly text: string;
}>;

export type HarnessSlackMessageProposalReceipt = Readonly<{
  readonly kind: "proposed";
  readonly proposalId: string;
  readonly version: number;
  /** The connected channel the draft points to, or null until a person picks one. */
  readonly channel: string | null;
}>;

export type HarnessWhatsAppSupportInbox = Readonly<{
  readonly scope: "active_cases";
  readonly cases: readonly Readonly<{
    readonly integrationAccountId: string;
    readonly caseId: string;
    readonly customerWaId: string;
    readonly openedAt: number;
    readonly serviceWindowExpiresAt: number;
    readonly ownership: "agent_active" | "human_owned";
    readonly messages: readonly Readonly<{
      readonly direction: "inbound" | "outbound";
      readonly occurredAt: number;
      readonly text: string;
    }>[];
  }>[];
  readonly truncated: boolean;
}>;

export type HarnessWhatsAppSupportReplySend = Readonly<{
  readonly caseId: string;
  readonly body: string;
}>;

export type HarnessWhatsAppSupportReplyReceipt = Readonly<{
  readonly kind: "sent";
  readonly caseId: string;
  readonly receiptId: string;
}>;

export type IntegrationList = (
  request: HarnessIntegrationListRequest,
) => Promise<IntegrationDiscoveryView>;

export type EmailMailboxSearch = (
  request: HarnessEmailMailboxSearch,
) => Promise<HarnessEmailMailboxSearchResult>;

export type EmailReplyPropose = (
  request: HarnessEmailReplyPropose,
) => Promise<HarnessEmailReplyProposalReceipt>;

/** Plan 40D: one Gmail reply's shared draft, which people may edit too. */
export type HarnessEmailReplyDraftRead = Readonly<{
  readonly integrationAccountId: string;
  readonly proposalId: string;
}>;

export type HarnessEmailReplyDraftEdit = HarnessEmailReplyDraftRead &
  Readonly<{ readonly oldText: string; readonly newText: string }>;

export type HarnessEmailReplyDraft = Readonly<{
  readonly proposalId: string;
  readonly body: string;
  /** The Gmail version that the text started from or was last saved as. */
  readonly savedVersion: number;
  /** True when the text differs from that version. */
  readonly unsaved: boolean;
}>;

export type EmailReplyDraftRead = (
  request: HarnessEmailReplyDraftRead,
) => Promise<HarnessEmailReplyDraft>;

export type EmailReplyDraftEdit = (
  request: HarnessEmailReplyDraftEdit,
  operationId: string,
  boundary: CatalogExecutionContext,
) => Promise<HarnessEmailReplyDraft>;

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

export type ProductionPlanReadTool = (
  request: HarnessProductionPlanRead,
) => Promise<HarnessProductionPlan>;

export type ProductionPlanEditTool = (
  request: HarnessProductionPlanEdit,
  operationId: string,
  boundary: CatalogExecutionContext,
) => Promise<HarnessProductionPlan>;

/**
 * Plan 40D: a plan request that the model can correct, such as a request that
 * no longer waits for acceptance. Its message reaches the model.
 */
export class ProductionPlanRequestError extends Error {}

/**
 * A description draft request that the model can correct, such as a product
 * id that names no product. Its message reaches the model.
 */
export class DescriptionDraftRequestError extends Error {}

export type EmailOperationalPropose = (
  request: HarnessEmailOperationalPropose,
) => Promise<HarnessEmailOperationalProposalReceipt>;

export type SlackMessagePropose = (
  request: HarnessSlackMessagePropose,
) => Promise<HarnessSlackMessageProposalReceipt>;

export type WhatsAppSupportRead = (
  request: HarnessWhatsAppSupportRead,
) => Promise<HarnessWhatsAppSupportInbox>;

export type WhatsAppSupportReplySend = (
  request: HarnessWhatsAppSupportReplySend,
) => Promise<HarnessWhatsAppSupportReplyReceipt>;

export type HarnessWorkspaceQuery =
  | { readonly kind: "read"; readonly path: string }
  | { readonly kind: "search"; readonly query: string; readonly limit: number };

export type HarnessWorkspaceQueryResult =
  | {
      readonly kind: "file";
      readonly revision: string;
      readonly path: string;
      readonly mediaType: string;
      readonly sha256: string;
      readonly content: string;
    }
  | {
      readonly kind: "matches";
      readonly revision: string;
      readonly matches: readonly {
        readonly path: string;
        readonly line: number;
        readonly excerpt: string;
      }[];
      readonly truncated: boolean;
    };

export type WorkspaceQuery = (
  input: HarnessWorkspaceQuery,
) => Promise<HarnessWorkspaceQueryResult>;

export type HarnessFileSearch = Readonly<{
  readonly query: string;
  readonly limit: number;
}>;

export type HarnessFileRead = Readonly<{
  readonly reference: CanonicalFileReference;
  readonly startSegment: number;
}>;

export type FileSearch = (
  input: HarnessFileSearch,
) => Promise<readonly FileSearchToolResult[]>;

export type FileRead = (input: HarnessFileRead) => Promise<FileReadToolResult>;

export type MessageAttachmentInspectResult = Readonly<Record<string, unknown>>;

export type MessageLinkReadResult = Readonly<Record<string, unknown>>;

export type MessageAttachmentInspect = (input: {
  readonly attachmentId: string;
}) => Promise<MessageAttachmentInspectResult>;

export type MessageLinkRead = (input: {
  readonly url: string;
}) => Promise<MessageLinkReadResult>;
