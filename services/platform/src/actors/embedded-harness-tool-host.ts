import type {
  WorkflowCanvasReadTool,
  WorkflowCanvasMoveTool,
} from "./workflow-canvas-tools";
import type {
  SavedBakeryRunQuery,
  SavedBakeryRunResult,
} from "../commerce/bakery/saved-runs";
import type {
  IntegrationDiscoveryView,
  CommerceContextRequest,
  CommerceGraphQueryResult,
} from "@seams/contracts";

import type { Env } from "../env";
import type { CodemodeRemote } from "@earendil-works/pi-codemode/portable";
import type { HarnessCodeModeSandbox } from "./embedded-harness";
import type { OrganisationId } from "../ids";
import type { RequestableCapability } from "../authorization/requestable-capabilities";
import { createCatalogHarnessCodeMode, harnessCapabilitiesFromCapabilityKeys } from "../agent-tools/catalog/code-mode";
import { catalogHarnessToolCatalogDigest, harnessBaseCapabilities } from "../agent-tools/catalog/selection";
import type {
  HarnessCapabilityClaim,
  HarnessCapabilityName,
  HarnessSourceAuthorization,
  HarnessBakerySurfaceExecute,
  HarnessMemoryProposal,
  HarnessFollowUpSchedule,
  HarnessSideCaseProposal,
  HarnessCustomConnectorRead,
  HarnessCustomConnectorWriteProposal,
  HarnessFileRead,
  HarnessFileSearch,
  HarnessEmailMailboxSearch,
  HarnessEmailMailboxSearchResult,
  HarnessEmailReplyPropose,
  EmailReplyDraftRead,
  EmailReplyDraftEdit,
  ProductionPlanEditTool,
  ProductionPlanReadTool,
  HarnessEmailReplyProposalReceipt,
  HarnessEmailOperationalPropose,
  HarnessEmailOperationalProposalReceipt,
  HarnessSlackMessagePropose,
  HarnessSlackMessageProposalReceipt,
  HarnessIntegrationListRequest,
  HarnessCampaignBriefRequest,
  HarnessConfigurationProposalRequest,
  OrderRefundProposal,
  StockActionProposal,
  CounterSaleReadTool,
  OrderQueueReadTool,
  PaymentsReadTool,
  OrderQueueAdvanceTool,
  SoldOutReadTool,
  SoldOutMarkTool,
  MenuBoardReadTool,
  MenuBoardEditTool,
  MenuBoardCreateTool,
  MenuBoardArchiveTool,
  MenuPriceProposal,
  RecipeReadTool,
  RecipeSaveTool,
  CostsReadTool,
  SupplyCostSaveTool,
  LotCostSaveTool,
  CostsPlanSaveTool,
  CostsSheetEditTool,
  SupplierReadTool,
  SupplierCreateTool,
  RecipeWorkflowReadTool,
  RecipeWorkflowProposeTool,
  DeviceReadTool,
  DevicePauseTool,
  DeviceProposeTool,
  DeviceSnapshotReadTool,
  JevFeaturesReadTool,
  JevFeatureProposeTool,
  HarnessMerchantReportRequest,
  HarnessWhatsAppSupportInbox,
  HarnessWhatsAppSupportRead,
  HarnessWhatsAppSupportReplyReceipt,
  HarnessWhatsAppSupportReplySend,
  ProductDescriptionDraftRead,
  ProductDescriptionDraftEdit,
  CafeMenuPublicationProposal,
  MenuDraftEditTool,
  MenuDraftReadTool,
  EmailDraftReadTool,
  EmailDraftEditTool,
  CommerceActionProposal,
  MerchantPluginProposal,
} from "../agent-tools/catalog/types";
import { type HarnessPermissionRequest, type HarnessPermissionRequestResult, type HarnessPermissionRequestTool, missingRequestableCapabilities } from "../agent-tools/catalog/permission";
import type {
  FileReadToolResult,
  FileSearchToolResult,
} from "../context/files";
import type { MerchantReportResult } from "../commerce/entity-plane/merchant-reports";
import { createHarnessCodeModeAdmission } from "./code-mode-admission";
import type { HarnessToolHost } from "./embedded-harness";
import type { HarnessTurnLease } from "@seams/contracts";
import type { CustomConnectorCatalogEntry } from "../custom-connectors";
import type { SurfaceToolCommandName } from "../agent-tools/define-tool";

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

export type HarnessToolHostConstructionError =
  | {
      readonly code: "embedded_harness_tool_catalog_digest_mismatch";
    }
  | {
      readonly code: "embedded_harness_resource_scope_invalid";
    }
  | {
      readonly code: "embedded_harness_custom_connector_unavailable";
    }
  | {
      readonly code: "embedded_harness_surface_unavailable";
    };

export function harnessToolCatalogDigest(
  allowedCapabilities: readonly HarnessCapabilityName[] = harnessBaseCapabilities(),
  customConnectorOperations: readonly CustomConnectorCatalogEntry[] = [],
  bakerySurfaceCommands: readonly SurfaceToolCommandName[] = [],
  memoryProposal = false,
  followUp = false,
  permissionRequest = false,
  sideCaseProposal = false,
): Promise<string> {
  return catalogHarnessToolCatalogDigest({
    allowedCapabilities,
    customConnectorOperations,
    bakerySurfaceCommands,
    memoryProposal,
    followUp,
    permissionRequest,
    sideCaseProposal,
  });
}

export async function createCatalogHarnessToolHost(input: {
  readonly env: Env;
  readonly storage: DurableObjectStorage;
  readonly organisationId: OrganisationId;
  readonly lease: HarnessTurnLease;
  readonly expectedCatalogDigest: string;
  readonly capabilityKeys: readonly string[];
  readonly customConnectorOperations: readonly CustomConnectorCatalogEntry[];
  readonly bakerySurfaceCommands: readonly SurfaceToolCommandName[];
  /** True when the turn's authority may propose a Memory. */
  readonly memoryProposal: boolean;
  /** True for a Slack thread turn, which may schedule a follow-up. */
  readonly followUp: boolean;
  /** True for a Slack thread or Portal chat turn, which may ask a person. */
  readonly permissionRequest: boolean;
  /** True for a Portal chat or Slack thread turn, which may propose a side Case. */
  readonly sideCaseProposal: boolean;
  readonly readCustomConnector: HarnessCustomConnectorRead;
  readonly proposeCustomConnectorWrite: HarnessCustomConnectorWriteProposal;
  readonly readAirtable?: (input: AirtableReadInput) => Promise<unknown>;
  readonly writeAirtable?: (input: AirtableWriteInput) => Promise<unknown>;
  readonly listIntegrations: (
    request: HarnessIntegrationListRequest,
  ) => Promise<IntegrationDiscoveryView>;
  readonly searchEmailMailbox: (
    request: HarnessEmailMailboxSearch,
  ) => Promise<HarnessEmailMailboxSearchResult>;
  readonly proposeEmailReply: (
    request: HarnessEmailReplyPropose,
  ) => Promise<HarnessEmailReplyProposalReceipt>;
  readonly readEmailReplyDraft: EmailReplyDraftRead;
  readonly editEmailReplyDraft: EmailReplyDraftEdit;
  readonly readProductionPlan?: ProductionPlanReadTool;
  readonly editProductionPlan?: ProductionPlanEditTool;
  readonly proposeEmailOperational: (
    request: HarnessEmailOperationalPropose,
  ) => Promise<HarnessEmailOperationalProposalReceipt>;
  readonly proposeSlackMessage: (
    request: HarnessSlackMessagePropose,
  ) => Promise<HarnessSlackMessageProposalReceipt>;
  readonly readWhatsAppSupport: (
    request: HarnessWhatsAppSupportRead,
  ) => Promise<HarnessWhatsAppSupportInbox>;
  readonly sendWhatsAppSupportReply: (
    request: HarnessWhatsAppSupportReplySend,
  ) => Promise<HarnessWhatsAppSupportReplyReceipt>;
  readonly readEntityContext: (
    request: CommerceContextRequest,
  ) => Promise<CommerceGraphQueryResult>;
  readonly readMerchantReport: (
    request: HarnessMerchantReportRequest,
  ) => Promise<MerchantReportResult>;
  readonly readWorkflowCanvas: WorkflowCanvasReadTool;
  readonly moveWorkflowCanvasObject: WorkflowCanvasMoveTool;
  readonly readProductDescriptionDraft: ProductDescriptionDraftRead;
  readonly editProductDescriptionDraft: ProductDescriptionDraftEdit;
  readonly readMenuDraft: MenuDraftReadTool;
  readonly editMenuDraft: MenuDraftEditTool;
  readonly proposeCafeMenuPublication: CafeMenuPublicationProposal;
  readonly readMenuBoards: MenuBoardReadTool;
  readonly editMenuBoard: MenuBoardEditTool;
  readonly createMenuBoard: MenuBoardCreateTool;
  readonly archiveMenuBoard: MenuBoardArchiveTool;
  readonly proposeMenuPrice: MenuPriceProposal;
  readonly proposeOrderRefund: OrderRefundProposal;
  readonly proposeStockAction: StockActionProposal;
  readonly readOrderQueue: OrderQueueReadTool;
  readonly readCounterSale?: CounterSaleReadTool;
  readonly readPayments: PaymentsReadTool;
  readonly advanceOrderQueue: OrderQueueAdvanceTool;
  readonly readSoldOut: SoldOutReadTool;
  readonly markSoldOut: SoldOutMarkTool;
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
  readonly readDevices: DeviceReadTool;
  readonly pauseDevice: DevicePauseTool;
  readonly proposeDevice: DeviceProposeTool;
  readonly readDeviceSnapshots: DeviceSnapshotReadTool;
  readonly readJevFeatures: JevFeaturesReadTool;
  readonly proposeJevFeature: JevFeatureProposeTool;
  readonly readEmailDraft: EmailDraftReadTool;
  readonly editEmailDraft: EmailDraftEditTool;
  readonly searchFiles: (
    input: HarnessFileSearch,
  ) => Promise<readonly FileSearchToolResult[]>;
  readonly readFile: (input: HarnessFileRead) => Promise<FileReadToolResult>;
  readonly inspectMessageAttachment: (input: {
    readonly attachmentId: string;
  }) => Promise<Readonly<Record<string, unknown>>>;
  readonly readMessageLink: (input: {
    readonly url: string;
  }) => Promise<Readonly<Record<string, unknown>>>;
  readonly proposeCommerceAction: CommerceActionProposal;
  readonly proposeMerchantPlugin: MerchantPluginProposal;
  /**
   * The staging tools. Required rather than optional on purpose: these
   * shipped advertised to the model but never wired, because an optional field
   * lets a construction site omit one silently. Required makes that a
   * compile error.
   */
  readonly proposeCampaignBrief: (
    request: HarnessCampaignBriefRequest,
  ) => Promise<unknown>;
  readonly proposeConfiguration: (
    request: HarnessConfigurationProposalRequest,
  ) => Promise<unknown>;
  readonly readSavedBakeryRun: (
    query: SavedBakeryRunQuery,
  ) => Promise<SavedBakeryRunResult>;
  readonly queryWorkspace: (
    input: HarnessWorkspaceQuery,
  ) => Promise<HarnessWorkspaceQueryResult>;
  readonly executeBakerySurface: HarnessBakerySurfaceExecute;
  readonly executeCostsViewCommand?: import("../agent-tools/costs/view").HarnessCostsViewExecute;
  readonly proposeMemory: HarnessMemoryProposal;
  readonly scheduleFollowUp: HarnessFollowUpSchedule;
  readonly proposeSideCase: HarnessSideCaseProposal;
  /**
   * Records a permission request of a Slack thread turn. The host passes only
   * capabilities that this turn lacks.
   */
  readonly requestPermission: HarnessPermissionRequestTool;
  readonly claimCapability: HarnessCapabilityClaim;
  readonly authorizeSources: HarnessSourceAuthorization;
  readonly nowNs: () => number;
}): Promise<
  | { readonly ok: true; readonly value: HarnessToolHost }
  | { readonly ok: false; readonly error: HarnessToolHostConstructionError }
> {
  const capabilities = harnessCapabilitiesFromCapabilityKeys(
    input.capabilityKeys,
  );
  if (!capabilities.ok) {
    return {
      ok: false,
      error: { code: "embedded_harness_resource_scope_invalid" },
    };
  }
  const authority = await createCatalogHarnessCodeMode({
    expectedCatalogDigest: input.expectedCatalogDigest,
    catalogSelection: {
      allowedCapabilities: capabilities.value,
      customConnectorOperations: input.customConnectorOperations,
      bakerySurfaceCommands: input.bakerySurfaceCommands,
      memoryProposal: input.memoryProposal,
      followUp: input.followUp,
      permissionRequest: input.permissionRequest,
      sideCaseProposal: input.sideCaseProposal,
    },
    nativeSandbox: codeModeSandbox(input.env),
    authorizeSources: input.authorizeSources,
    admission: createHarnessCodeModeAdmission({
      env: input.env,
      storage: input.storage,
      organisationId: input.organisationId,
      lease: input.lease,
      catalogDigest: input.expectedCatalogDigest,
    }),
    listIntegrations: input.listIntegrations,
    readAirtable: input.readAirtable,
    writeAirtable: input.writeAirtable,
    searchEmailMailbox: input.searchEmailMailbox,
    proposeEmailReply: input.proposeEmailReply,
    readEmailReplyDraft: input.readEmailReplyDraft,
    editEmailReplyDraft: input.editEmailReplyDraft,
    readProductionPlan: input.readProductionPlan,
    editProductionPlan: input.editProductionPlan,
    proposeEmailOperational: input.proposeEmailOperational,
    proposeSlackMessage: input.proposeSlackMessage,
    readWhatsAppSupport: input.readWhatsAppSupport,
    sendWhatsAppSupportReply: input.sendWhatsAppSupportReply,
    readEntityContext: input.readEntityContext,
    readMerchantReport: input.readMerchantReport,
    readWorkflowCanvas: input.readWorkflowCanvas,
    moveWorkflowCanvasObject: input.moveWorkflowCanvasObject,
    readProductDescriptionDraft: input.readProductDescriptionDraft,
    editProductDescriptionDraft: input.editProductDescriptionDraft,
    readMenuDraft: input.readMenuDraft,
    editMenuDraft: input.editMenuDraft,
    proposeCafeMenuPublication: input.proposeCafeMenuPublication,
    readMenuBoards: input.readMenuBoards,
    editMenuBoard: input.editMenuBoard,
    createMenuBoard: input.createMenuBoard,
    archiveMenuBoard: input.archiveMenuBoard,
    proposeMenuPrice: input.proposeMenuPrice,
    proposeOrderRefund: input.proposeOrderRefund,
    proposeStockAction: input.proposeStockAction,
    readOrderQueue: input.readOrderQueue,
    readCounterSale: input.readCounterSale,
    readPayments: input.readPayments,
    advanceOrderQueue: input.advanceOrderQueue,
    readSoldOut: input.readSoldOut,
    markSoldOut: input.markSoldOut,
    readRecipes: input.readRecipes,
    saveRecipe: input.saveRecipe,
    readCosts: input.readCosts,
    saveSupplyCost: input.saveSupplyCost,
    saveLotCost: input.saveLotCost,
    saveCostsPlan: input.saveCostsPlan,
    editCostsSheet: input.editCostsSheet,
    readSuppliers: input.readSuppliers,
    createSupplier: input.createSupplier,
    readRecipeWorkflow: input.readRecipeWorkflow,
    proposeRecipeWorkflow: input.proposeRecipeWorkflow,
    readDevices: input.readDevices,
    pauseDevice: input.pauseDevice,
    proposeDevice: input.proposeDevice,
    readDeviceSnapshots: input.readDeviceSnapshots,
    readJevFeatures: input.readJevFeatures,
    proposeJevFeature: input.proposeJevFeature,
    readEmailDraft: input.readEmailDraft,
    editEmailDraft: input.editEmailDraft,
    searchFiles: input.searchFiles,
    readFile: input.readFile,
    inspectMessageAttachment: input.inspectMessageAttachment,
    readMessageLink: input.readMessageLink,
    readCustomConnector: input.readCustomConnector,
    proposeCustomConnectorWrite: input.proposeCustomConnectorWrite,
    proposeCommerceAction: input.proposeCommerceAction,
    proposeMerchantPlugin: input.proposeMerchantPlugin,
    proposeCampaignBrief: input.proposeCampaignBrief,
    proposeConfiguration: input.proposeConfiguration,
    readSavedBakeryRun: input.readSavedBakeryRun,
    queryWorkspace: input.queryWorkspace,
    executeBakerySurface: input.executeBakerySurface,
    ...(input.executeCostsViewCommand === undefined
      ? {}
      : { executeCostsViewCommand: input.executeCostsViewCommand }),
    proposeMemory: input.proposeMemory,
    scheduleFollowUp: input.scheduleFollowUp,
    proposeSideCase: input.proposeSideCase,
    requestPermission: requestOnlyMissingCapabilities.bind(
      null,
      input.requestPermission,
      missingRequestableCapabilities(capabilities.value),
    ),
    claimCapability: input.claimCapability,
    nowNs: input.nowNs,
  });
  return authority;
}

/**
 * A turn asks only for what it lacks. The tool lists only those capabilities,
 * so another name means a call that the catalogue did not offer.
 */
function requestOnlyMissingCapabilities(
  request: HarnessPermissionRequestTool,
  missing: readonly RequestableCapability[],
  input: HarnessPermissionRequest,
): Promise<HarnessPermissionRequestResult> {
  for (const capability of input.capabilityIds)
    if (!missing.includes(capability))
      throw new TypeError(
        "request_permission names a capability this turn holds",
      );
  return request(input);
}

/**
 * One sandbox object for each execution, named by the stable execution
 * identity. Every attempt of an execution reaches the same object, and the
 * scripts of other executions do not share its thread.
 */
export function codeModeSandbox(env: Env): HarnessCodeModeSandbox | null {
  const namespace = env.CODE_MODE_SANDBOX;
  return namespace === undefined
    ? null
    : codeModeSandboxRemote.bind(null, namespace);
}

function codeModeSandboxRemote(
  namespace: NonNullable<Env["CODE_MODE_SANDBOX"]>,
  executionId: string,
): CodemodeRemote {
  const sandbox = namespace.getByName(executionId);
  return {
    async execute(request, exchange) {
      await sandbox.execute(request, exchange);
    },
  };
}

import type {
  AirtableReadInput,
  AirtableWriteInput,
} from "./airtable-tool-input";
