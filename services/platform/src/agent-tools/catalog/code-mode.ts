import type {
  WorkflowCanvasReadTool,
  WorkflowCanvasMoveTool,
} from "../../actors/workflow-canvas-tools";
import type {
  CostsPlanSaveTool,
  CostsReadTool,
  CostsSheetEditTool,
  LotCostSaveTool,
  SupplyCostSaveTool,
} from "../kitchen/costs";
import type {
  SavedBakeryRunQuery,
  SavedBakeryRunResult,
} from "../../commerce/bakery/saved-runs";
import type {
  AirtableReadInput,
  AirtableWriteInput,
} from "../../actors/airtable-tool-input";
import type { HarnessCodeModeSandbox } from "../../actors/embedded-harness";
import type { Result } from "../../result";
import { CONTEXT_CASE_READ_SCOPE } from "../../authorization/access-grants/turn-authority";
import type {
  FileReadToolResult,
  FileSearchToolResult,
} from "../../context/files";
import {
  CAPABILITY_KEYS,
  EMAIL_MAILBOX_RESOURCE_SCOPE,
  EMAIL_OPERATIONAL_RESOURCE_SCOPE,
  SLACK_MESSAGE_RESOURCE_SCOPE,
  WHATSAPP_SUPPORT_ACTIVE_CASES_SCOPE,
} from "../../authorization/capability-catalogue";
import { parseCapabilityKey } from "../../authorization/access-grants/capability-key";
import {
  customConnectorCapabilityFromKey,
  isReadEntry,
  isWriteEntry,
} from "./custom-connectors";
import { executeCatalogTool, executeNativeCatalogTool } from "./execute";
import type { HarnessPermissionRequestTool } from "./permission";
import {
  catalogHarnessToolCatalogDigest,
  harnessBaseCapabilities,
  selectCatalogDefinitions,
} from "./selection";
import type {
  CafeMenuPublicationProposal,
  CampaignBriefPropose,
  CommerceActionProposal,
  ConfigurationPropose,
  DevicePauseTool,
  DeviceProposeTool,
  DeviceReadTool,
  DeviceSnapshotReadTool,
  EmailDraftEditTool,
  EmailDraftReadTool,
  EmailMailboxSearch,
  EmailOperationalPropose,
  EmailReplyDraftEdit,
  EmailReplyDraftRead,
  EmailReplyPropose,
  EntityContextRead,
  FileRead,
  FileSearch,
  HarnessBakerySurfaceExecute,
  HarnessCapabilityClaim,
  HarnessCapabilityClaimInput,
  HarnessCapabilityName,
  HarnessCatalogSelection,
  HarnessCodeModeAdmission,
  HarnessCodeModeAuthority,
  HarnessCodeModeConstructionError,
  HarnessCustomConnectorRead,
  HarnessCustomConnectorWriteProposal,
  HarnessEmailMailboxSearchResult,
  HarnessEmailOperationalProposalReceipt,
  HarnessEmailReplyDraft,
  HarnessEmailReplyProposalReceipt,
  HarnessFollowUpSchedule,
  HarnessMemoryProposal,
  HarnessProductionPlan,
  HarnessResourceScopeError,
  HarnessSideCaseProposal,
  HarnessSlackMessageProposalReceipt,
  HarnessSourceAuthorization,
  HarnessWhatsAppSupportInbox,
  HarnessWhatsAppSupportReplyReceipt,
  IntegrationList,
  MenuBoardEditTool,
  MenuBoardCreateTool,
  MenuBoardArchiveTool,
  MenuBoardReadTool,
  MenuDraftEditTool,
  MenuDraftReadTool,
  MenuPriceProposal,
  JevFeatureProposeTool,
  JevFeaturesReadTool,
  MerchantPluginProposal,
  MerchantReportRead,
  MessageAttachmentInspect,
  MessageAttachmentInspectResult,
  MessageLinkRead,
  MessageLinkReadResult,
  OrderQueueAdvanceTool,
  OrderQueueReadTool,
  OrderRefundProposal,
  PaymentsReadTool,
  ProductDescriptionDraftEdit,
  ProductDescriptionDraftRead,
  ProductionPlanEditTool,
  ProductionPlanReadTool,
  RecipeReadTool,
  RecipeSaveTool,
  RecipeWorkflowProposeTool,
  RecipeWorkflowReadTool,
  SlackMessagePropose,
  SoldOutMarkTool,
  SoldOutReadTool,
  StockActionProposal,
  SupplierCreateTool,
  SupplierReadTool,
  WhatsAppSupportRead,
  WhatsAppSupportReplySend,
  WorkspaceProductFolderUpdate,
  WorkspaceQuery,
} from "./types";

export const MAX_CODE_MODE_SOURCE_BYTES = 64 * 1024;

export async function unavailableAttachmentInspect(): Promise<MessageAttachmentInspectResult> {
  throw new Error("message attachment inspection is unavailable");
}

export async function unavailableMessageLinkRead(): Promise<MessageLinkReadResult> {
  throw new Error("public link reading is unavailable");
}

export async function unavailableFileSearch(): Promise<
  readonly FileSearchToolResult[]
> {
  throw new Error("file search is unavailable");
}

export async function unavailableFileRead(): Promise<FileReadToolResult> {
  throw new Error("file read is unavailable");
}

export async function unavailableEmailMailboxSearch(): Promise<HarnessEmailMailboxSearchResult> {
  throw new Error("Email mailbox search is unavailable");
}

export async function unavailableEmailReplyPropose(): Promise<HarnessEmailReplyProposalReceipt> {
  throw new Error("Email reply proposal is unavailable");
}

export async function unavailableEmailReplyDraft(): Promise<HarnessEmailReplyDraft> {
  throw new Error("Email reply drafts are unavailable");
}

export async function unavailableProductionPlan(): Promise<HarnessProductionPlan> {
  throw new Error("Production plans are unavailable");
}

export async function unavailableEmailOperationalPropose(): Promise<HarnessEmailOperationalProposalReceipt> {
  throw new Error("Operational email proposal is unavailable");
}

export async function unavailableSlackMessagePropose(): Promise<HarnessSlackMessageProposalReceipt> {
  throw new Error("Slack message drafting is unavailable");
}

export async function unavailableWhatsAppSupportRead(): Promise<HarnessWhatsAppSupportInbox> {
  throw new Error("WhatsApp support read is unavailable");
}

export async function unavailableWhatsAppSupportReplySend(): Promise<HarnessWhatsAppSupportReplyReceipt> {
  throw new Error("WhatsApp support reply send is unavailable");
}

export function harnessCapabilitiesFromCapabilityKeys(
  capabilityKeys: readonly string[],
): Result<readonly HarnessCapabilityName[], HarnessResourceScopeError> {
  const capabilities: HarnessCapabilityName[] = [];
  const seen = new Set<HarnessCapabilityName>();
  const resourceDerived = new Set<HarnessCapabilityName>();
  for (const scope of capabilityKeys) {
    if (
      scope === CONTEXT_CASE_READ_SCOPE ||
      scope === `platform:${CAPABILITY_KEYS.customConnectorDraft}:1`
    ) {
      continue;
    }
    if (scope.startsWith("custom_connector:")) {
      const customCapability = customConnectorCapabilityFromKey(scope);
      if (customCapability === null) {
        return {
          ok: false,
          error: { code: "embedded_harness_resource_scope_invalid", scope },
        };
      }
      if (!seen.has(customCapability)) {
        seen.add(customCapability);
        capabilities.push(customCapability);
      }
      continue;
    }
    if (scope.startsWith("provider:")) {
      const providerCapability = capabilityFromProviderResourceScope(scope);
      if (providerCapability === null) {
        return {
          ok: false,
          error: { code: "embedded_harness_resource_scope_invalid", scope },
        };
      }
      resourceDerived.add(providerCapability);
      if (!seen.has(providerCapability)) {
        seen.add(providerCapability);
        capabilities.push(providerCapability);
      }
      continue;
    }
    if (scope.startsWith("file:")) {
      const fileCapability = capabilityFromFileResourceScope(scope);
      if (fileCapability === null) {
        return {
          ok: false,
          error: { code: "embedded_harness_resource_scope_invalid", scope },
        };
      }
      resourceDerived.add(fileCapability);
      if (!seen.has(fileCapability)) {
        seen.add(fileCapability);
        capabilities.push(fileCapability);
      }
      continue;
    }
    const capability = capabilityFromResourceScope(scope);
    if (
      capability === null ||
      (seen.has(capability) && !resourceDerived.has(capability))
    ) {
      return {
        ok: false,
        error: { code: "embedded_harness_resource_scope_invalid", scope },
      };
    }
    if (seen.has(capability)) {
      continue;
    }
    seen.add(capability);
    capabilities.push(capability);
  }
  capabilities.sort(compareCapabilities);
  return { ok: true, value: Object.freeze(capabilities) };
}

export async function createCatalogHarnessCodeMode(input: {
  readonly expectedCatalogDigest: string;
  readonly catalogSelection?: HarnessCatalogSelection;
  /**
   * Absent: this host has no native Code Mode. `null`: it has, and this
   * deployment lacks the sandbox Worker.
   */
  readonly nativeSandbox?: HarnessCodeModeSandbox | null;
  /** Required for native Code Mode. Without it every replayed result is denied. */
  readonly authorizeSources?: HarnessSourceAuthorization;
  readonly listIntegrations: IntegrationList;
  readonly readAirtable?: (input: AirtableReadInput) => Promise<unknown>;
  readonly writeAirtable?: (input: AirtableWriteInput) => Promise<unknown>;
  readonly searchEmailMailbox?: EmailMailboxSearch;
  readonly proposeEmailReply?: EmailReplyPropose;
  readonly readEmailReplyDraft?: EmailReplyDraftRead;
  readonly editEmailReplyDraft?: EmailReplyDraftEdit;
  readonly readProductionPlan?: ProductionPlanReadTool;
  readonly editProductionPlan?: ProductionPlanEditTool;
  readonly proposeEmailOperational?: EmailOperationalPropose;
  readonly proposeSlackMessage?: SlackMessagePropose;
  readonly readWhatsAppSupport?: WhatsAppSupportRead;
  readonly sendWhatsAppSupportReply?: WhatsAppSupportReplySend;
  readonly readEntityContext: EntityContextRead;
  readonly readMerchantReport: MerchantReportRead;
  readonly readWorkflowCanvas: WorkflowCanvasReadTool;
  readonly moveWorkflowCanvasObject: WorkflowCanvasMoveTool;
  readonly readProductDescriptionDraft: ProductDescriptionDraftRead;
  readonly editProductDescriptionDraft: ProductDescriptionDraftEdit;
  readonly readMenuDraft: MenuDraftReadTool;
  readonly editMenuDraft?: MenuDraftEditTool;
  readonly proposeCafeMenuPublication?: CafeMenuPublicationProposal;
  readonly readMenuBoards?: MenuBoardReadTool;
  readonly editMenuBoard?: MenuBoardEditTool;
  readonly createMenuBoard?: MenuBoardCreateTool;
  readonly archiveMenuBoard?: MenuBoardArchiveTool;
  readonly proposeMenuPrice?: MenuPriceProposal;
  readonly proposeOrderRefund?: OrderRefundProposal;
  readonly proposeStockAction?: StockActionProposal;
  readonly readOrderQueue?: OrderQueueReadTool;
  readonly readPayments?: PaymentsReadTool;
  readonly advanceOrderQueue?: OrderQueueAdvanceTool;
  readonly readSoldOut?: SoldOutReadTool;
  readonly markSoldOut?: SoldOutMarkTool;
  readonly readRecipes?: RecipeReadTool;
  readonly saveRecipe?: RecipeSaveTool;
  readonly readCosts?: CostsReadTool;
  readonly saveSupplyCost?: SupplyCostSaveTool;
  readonly saveLotCost?: LotCostSaveTool;
  readonly saveCostsPlan?: CostsPlanSaveTool;
  readonly editCostsSheet?: CostsSheetEditTool;
  readonly readSuppliers?: SupplierReadTool;
  readonly createSupplier?: SupplierCreateTool;
  readonly readRecipeWorkflow?: RecipeWorkflowReadTool;
  readonly proposeRecipeWorkflow?: RecipeWorkflowProposeTool;
  readonly readDevices?: DeviceReadTool;
  readonly pauseDevice?: DevicePauseTool;
  readonly proposeDevice?: DeviceProposeTool;
  readonly readDeviceSnapshots?: DeviceSnapshotReadTool;
  readonly readJevFeatures?: JevFeaturesReadTool;
  readonly proposeJevFeature?: JevFeatureProposeTool;
  readonly readEmailDraft: EmailDraftReadTool;
  readonly editEmailDraft: EmailDraftEditTool;
  readonly proposeCampaignBrief?: CampaignBriefPropose;
  readonly proposeConfiguration?: ConfigurationPropose;
  readonly searchFiles?: FileSearch;
  readonly readFile?: FileRead;
  readonly inspectMessageAttachment?: MessageAttachmentInspect;
  readonly readMessageLink?: MessageLinkRead;
  readonly readCustomConnector?: HarnessCustomConnectorRead;
  readonly proposeCustomConnectorWrite?: HarnessCustomConnectorWriteProposal;
  readonly proposeCommerceAction?: CommerceActionProposal;
  readonly proposeMerchantPlugin?: MerchantPluginProposal;
  readonly queryWorkspace: WorkspaceQuery;
  readonly readSavedBakeryRun?: (
    query: SavedBakeryRunQuery,
  ) => Promise<SavedBakeryRunResult>;
  readonly updateWorkspaceProductFolder: WorkspaceProductFolderUpdate;
  readonly executeBakerySurface?: HarnessBakerySurfaceExecute;
  readonly executeCostsViewCommand?: import("../costs/view").HarnessCostsViewExecute;
  readonly proposeMemory?: HarnessMemoryProposal;
  readonly scheduleFollowUp?: HarnessFollowUpSchedule;
  readonly proposeSideCase?: HarnessSideCaseProposal;
  readonly requestPermission?: HarnessPermissionRequestTool;
  readonly admission: HarnessCodeModeAdmission;
  readonly claimCapability: HarnessCapabilityClaim;
  readonly nowNs: () => number;
}): Promise<
  Result<HarnessCodeModeAuthority, HarnessCodeModeConstructionError>
> {
  const catalogSelection = input.catalogSelection ?? {
    allowedCapabilities: harnessBaseCapabilities(),
  };
  const definitions = selectCatalogDefinitions(catalogSelection);
  const catalogDigest = await catalogHarnessToolCatalogDigest(catalogSelection);
  if (catalogDigest !== input.expectedCatalogDigest) {
    return {
      ok: false,
      error: { code: "embedded_harness_tool_catalog_digest_mismatch" },
    };
  }
  if (
    (catalogSelection.customConnectorOperations?.some(isReadEntry) ?? false) &&
    input.readCustomConnector === undefined
  ) {
    return {
      ok: false,
      error: { code: "embedded_harness_custom_connector_unavailable" },
    };
  }
  if (
    (catalogSelection.bakerySurfaceCommands?.length ?? 0) > 0 &&
    input.executeBakerySurface === undefined
  ) {
    return {
      ok: false,
      error: { code: "embedded_harness_surface_unavailable" },
    };
  }
  if (
    (catalogSelection.customConnectorOperations?.some(isWriteEntry) ?? false) &&
    input.proposeCustomConnectorWrite === undefined
  ) {
    return {
      ok: false,
      error: { code: "embedded_harness_custom_connector_unavailable" },
    };
  }
  const searchFiles = input.searchFiles ?? unavailableFileSearch;
  const readFile = input.readFile ?? unavailableFileRead;
  const inspectMessageAttachment =
    input.inspectMessageAttachment ?? unavailableAttachmentInspect;
  const readMessageLink = input.readMessageLink ?? unavailableMessageLinkRead;
  const searchEmailMailbox =
    input.searchEmailMailbox ?? unavailableEmailMailboxSearch;
  const proposeEmailReply =
    input.proposeEmailReply ?? unavailableEmailReplyPropose;
  const readEmailReplyDraft =
    input.readEmailReplyDraft ?? unavailableEmailReplyDraft;
  const editEmailReplyDraft =
    input.editEmailReplyDraft ?? unavailableEmailReplyDraft;
  const readProductionPlan =
    input.readProductionPlan ?? unavailableProductionPlan;
  const editProductionPlan =
    input.editProductionPlan ?? unavailableProductionPlan;
  const proposeEmailOperational =
    input.proposeEmailOperational ?? unavailableEmailOperationalPropose;
  const proposeSlackMessage =
    input.proposeSlackMessage ?? unavailableSlackMessagePropose;
  const readWhatsAppSupport =
    input.readWhatsAppSupport ?? unavailableWhatsAppSupportRead;
  const sendWhatsAppSupportReply =
    input.sendWhatsAppSupportReply ?? unavailableWhatsAppSupportReplySend;
  const claimedCapabilities: ClaimedCapabilities = new Map();
  const authority = {
    definitions,
    customConnectorOperations: catalogSelection.customConnectorOperations ?? [],
    catalogDigest,
    listIntegrations: input.listIntegrations,
    readAirtable: input.readAirtable,
    writeAirtable: input.writeAirtable,
    searchEmailMailbox,
    proposeEmailReply,
    readEmailReplyDraft,
    editEmailReplyDraft,
    readProductionPlan,
    editProductionPlan,
    proposeEmailOperational,
    proposeSlackMessage,
    readWhatsAppSupport,
    sendWhatsAppSupportReply,
    readEntityContext: input.readEntityContext,
    readMerchantReport: input.readMerchantReport,
    readWorkflowCanvas: input.readWorkflowCanvas,
    moveWorkflowCanvasObject: input.moveWorkflowCanvasObject,
    readProductDescriptionDraft: input.readProductDescriptionDraft,
    editProductDescriptionDraft: input.editProductDescriptionDraft,
    readMenuDraft: input.readMenuDraft,
    editMenuDraft: input.editMenuDraft,
    readMenuBoards: input.readMenuBoards,
    editMenuBoard: input.editMenuBoard,
    createMenuBoard: input.createMenuBoard,
    archiveMenuBoard: input.archiveMenuBoard,
    proposeMenuPrice: input.proposeMenuPrice,
    proposeCafeMenuPublication: input.proposeCafeMenuPublication,
    proposeOrderRefund: input.proposeOrderRefund,
    proposeStockAction: input.proposeStockAction,
    readOrderQueue: input.readOrderQueue,
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
    proposeCampaignBrief: input.proposeCampaignBrief,
    proposeConfiguration: input.proposeConfiguration,
    searchFiles,
    readFile,
    inspectMessageAttachment,
    readMessageLink,
    readCustomConnector: input.readCustomConnector,
    proposeCustomConnectorWrite: input.proposeCustomConnectorWrite,
    proposeCommerceAction: input.proposeCommerceAction,
    proposeMerchantPlugin: input.proposeMerchantPlugin,
    queryWorkspace: input.queryWorkspace,
    readSavedBakeryRun: input.readSavedBakeryRun,
    updateWorkspaceProductFolder: input.updateWorkspaceProductFolder,
    executeBakerySurface: input.executeBakerySurface,
    ...(input.executeCostsViewCommand === undefined
      ? {}
      : { executeCostsViewCommand: input.executeCostsViewCommand }),
    proposeMemory: input.proposeMemory,
    scheduleFollowUp: input.scheduleFollowUp,
    proposeSideCase: input.proposeSideCase,
    requestPermission: input.requestPermission,
    admission: input.admission,
    claimCapability: recordCapabilityClaim.bind(
      null,
      claimedCapabilities,
      input.claimCapability,
    ),
    nowNs: input.nowNs,
  };
  return {
    ok: true,
    value: {
      mode: "hybrid",
      catalogDigest,
      definitions,
      codeMode:
        input.nativeSandbox === undefined
          ? { kind: "disabled" }
          : {
              kind: "enabled",
              sandbox: input.nativeSandbox,
              admission: input.admission,
              executeTool: executeNativeCatalogTool.bind(null, authority),
              claimedCapabilities: readClaimedCapabilities.bind(
                null,
                claimedCapabilities,
              ),
              authorizeSources: authorizeRecordedSources.bind(
                null,
                catalogSelection.allowedCapabilities,
                input.authorizeSources,
              ),
            },
      claimCapability: input.claimCapability,
      executeTool: executeCatalogTool.bind(null, authority, { kind: "direct" }),
    },
  };
}

/** The capabilities that each call of this host claimed, by call ID. */
export type ClaimedCapabilities = Map<string, Set<HarnessCapabilityName>>;

export async function recordCapabilityClaim(
  claimed: ClaimedCapabilities,
  claimCapability: HarnessCapabilityClaim,
  input: HarnessCapabilityClaimInput,
): ReturnType<HarnessCapabilityClaim> {
  const result = await claimCapability(input);
  if (result.ok) {
    const capabilities = claimed.get(input.callId) ?? new Set();
    capabilities.add(input.capability);
    claimed.set(input.callId, capabilities);
  }
  return result;
}

export function readClaimedCapabilities(
  claimed: ClaimedCapabilities,
  callId: string,
): readonly string[] {
  return [...(claimed.get(callId) ?? [])].sort();
}

/**
 * A recorded source is a name from storage. It counts only when this turn's
 * catalog still allows the capability, and current authority still grants it.
 */
export async function authorizeRecordedSources(
  allowed: readonly HarnessCapabilityName[],
  authorizeSources: HarnessSourceAuthorization | undefined,
  capabilities: readonly string[],
): Promise<Result<null, { readonly detail: string }>> {
  if (authorizeSources === undefined) {
    return { ok: false, error: { detail: "source_authorization_unavailable" } };
  }
  const sources: HarnessCapabilityName[] = [];
  for (const capability of capabilities) {
    const source = allowed.find(sameCapability.bind(null, capability));
    if (source === undefined) {
      return { ok: false, error: { detail: "source_outside_catalog" } };
    }
    sources.push(source);
  }
  return authorizeSources(sources);
}

export function sameCapability(
  name: string,
  capability: HarnessCapabilityName,
): boolean {
  return capability === name;
}

export function capabilityFromResourceScope(
  scope: string,
): HarnessCapabilityName | null {
  const match = /^platform:(.+):1$/u.exec(scope);
  if (match === null) {
    return null;
  }
  switch (match[1]) {
    case CAPABILITY_KEYS.integrationDiscoveryRead:
    case CAPABILITY_KEYS.commerceEntityPlaneContext:
    case CAPABILITY_KEYS.commerceWorkflowCanvasMove:
    case CAPABILITY_KEYS.commerceProductDescriptionDraftEdit:
    case CAPABILITY_KEYS.commerceMenuDraftRead:
    case CAPABILITY_KEYS.commerceMenuDraftEdit:
    case CAPABILITY_KEYS.commerceProductionPlanEdit:
    case CAPABILITY_KEYS.commerceOrderQueueAdvance:
    case CAPABILITY_KEYS.commerceSoldOutMark:
    case CAPABILITY_KEYS.commerceRecipeSave:
    case CAPABILITY_KEYS.commerceSupplyCostSave:
    case CAPABILITY_KEYS.commerceSupplierCreate:
    case CAPABILITY_KEYS.recipeWorkflowRead:
    case CAPABILITY_KEYS.recipeWorkflowPropose:
    case CAPABILITY_KEYS.deviceRead:
    case CAPABILITY_KEYS.devicePause:
    case CAPABILITY_KEYS.deviceCameraRead:
    case CAPABILITY_KEYS.jevFeaturesRead:
    case CAPABILITY_KEYS.jevFeaturesManage:
    case CAPABILITY_KEYS.marketingEmailDraftEdit:
    case CAPABILITY_KEYS.commerceActionPropose:
    case CAPABILITY_KEYS.messageAttachmentInspect:
    case CAPABILITY_KEYS.messageLinkRead:
    case CAPABILITY_KEYS.workspaceQuery:
    case CAPABILITY_KEYS.workspaceProductFolderUpdate:
      return match[1];
    default:
      return null;
  }
}

export function capabilityFromProviderResourceScope(
  scope: string,
): HarnessCapabilityName | null {
  const providerPrefix = "provider:";
  if (!scope.startsWith(providerPrefix)) {
    return null;
  }
  const capabilityStart = providerPrefix.length;
  const capabilityEnd = scope.indexOf(":", capabilityStart);
  if (capabilityEnd < 0) {
    return null;
  }
  const versionStart = capabilityEnd + 1;
  const versionEnd = scope.indexOf(":", versionStart);
  if (versionEnd < 0) {
    return null;
  }
  const accountStart = versionEnd + 1;
  const accountEnd = scope.indexOf(":", accountStart);
  if (accountEnd < 0) {
    return null;
  }
  const capabilityId = scope.slice(capabilityStart, capabilityEnd);
  const version = scope.slice(versionStart, versionEnd);
  const integrationAccountId = scope.slice(accountStart, accountEnd);
  const resourceScope = scope.slice(accountEnd + 1);
  if (
    version !== "1" ||
    integrationAccountId.length === 0 ||
    resourceScope.length === 0
  ) {
    return null;
  }
  switch (capabilityId) {
    case CAPABILITY_KEYS.airtableApiRead:
    case CAPABILITY_KEYS.airtableApiWrite:
      return /^base:app[A-Za-z0-9]{8,32}$/u.test(resourceScope)
        ? capabilityId
        : null;
    case CAPABILITY_KEYS.commerceEntityPlaneContext:
    case CAPABILITY_KEYS.commerceActionPropose:
    case CAPABILITY_KEYS.fileRead:
    case CAPABILITY_KEYS.workspaceQuery:
    case CAPABILITY_KEYS.workspaceProductFolderUpdate:
      return capabilityId;
    case CAPABILITY_KEYS.whatsappSupportRead:
    case CAPABILITY_KEYS.whatsappSupportReplySend:
      return resourceScope === WHATSAPP_SUPPORT_ACTIVE_CASES_SCOPE
        ? capabilityId
        : null;
    case CAPABILITY_KEYS.emailMailboxRead:
    case CAPABILITY_KEYS.emailReplyPropose:
      return resourceScope === EMAIL_MAILBOX_RESOURCE_SCOPE
        ? capabilityId
        : null;
    case CAPABILITY_KEYS.emailOperationalPropose:
      return resourceScope === EMAIL_OPERATIONAL_RESOURCE_SCOPE
        ? capabilityId
        : null;
    case CAPABILITY_KEYS.slackMessagePropose:
      return resourceScope === SLACK_MESSAGE_RESOURCE_SCOPE
        ? capabilityId
        : null;
    default:
      return null;
  }
}

export function capabilityFromFileResourceScope(
  scope: string,
): HarnessCapabilityName | null {
  const parsed = parseCapabilityKey(scope);
  return parsed.ok &&
    parsed.value.kind === "file_resource" &&
    parsed.value.capabilityId === CAPABILITY_KEYS.fileRead
    ? CAPABILITY_KEYS.fileRead
    : null;
}

export function compareCapabilities(
  left: HarnessCapabilityName,
  right: HarnessCapabilityName,
): number {
  return left.localeCompare(right);
}
