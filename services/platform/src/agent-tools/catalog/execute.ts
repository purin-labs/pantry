import { CommerceContextToolResult } from "../../actors/commerce-context-tool-result";
import {
  bakerySurfaceToolSucceeded,
  readBakerySurfaceReceiptId,
} from "../bakery/surface";
import type { RegisteredTool } from "../define-tool";
import { ToolRequestError } from "../errors";
import { registeredTool } from "../registry";
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
import type { CommerceContextRequest } from "@purin-labs/contracts";
import type {
  AuthorizedHarnessToolResult,
  HarnessToolOutput,
} from "@purin-labs/contracts";
import { parseCommerceGraphQuery } from "../../commerce/entity-plane/routes";
import { CAPABILITY_KEYS } from "../../authorization/capability-catalogue";
import type { CustomConnectorCatalogEntry } from "../../custom-connectors";
import { errorMessage, isRecord, sha256Hex } from "@purin-labs/std";
import {
  findCustomConnectorOperation,
  isReadEntry,
  isWriteEntry,
} from "./custom-connectors";
import {
  type HarnessPermissionRequestTool,
  PERMISSION_REQUEST_TOOL_NAME,
  parsePermissionRequestArgs,
  requestDeniedRead,
} from "./permission";
import {
  isSelectedCatalogToolName,
  isStaticHarnessToolName,
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
  HarnessCapabilityName,
  HarnessCodeModeExecutionLease,
  HarnessCustomConnectorRead,
  HarnessCustomConnectorWriteProposal,
  HarnessFollowUpSchedule,
  HarnessMemoryProposal,
  HarnessSideCaseProposal,
  HarnessToolDefinition,
  IntegrationList,
  JevFeatureProposeTool,
  JevFeaturesReadTool,
  MenuBoardEditTool,
  MenuBoardCreateTool,
  MenuBoardArchiveTool,
  MenuBoardReadTool,
  MenuDraftEditTool,
  MenuDraftReadTool,
  MenuPriceProposal,
  MerchantPluginProposal,
  MerchantReportRead,
  MessageAttachmentInspect,
  MessageLinkRead,
  CounterSaleReadTool,
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
  WorkspaceQuery,
} from "./types";

const MAX_CODE_MODE_OUTPUT_BYTES = 24 * 1024;

const ENCODER = new TextEncoder();


const CAPABILITY_FAILURE_TEXT =
  "The capability could not complete this request. Authoritative data is unavailable; retry once without inferring a broader outage.";

class CommerceContextRequestError extends ToolRequestError {}

/** A call that the run's tool-call budget refused: retrying cannot help. */
class CapabilityBudgetError extends ToolRequestError {}

const CAPABILITY_BUDGET_TEXT =
  "This conversation used its budget of tool calls, so this call did not run. Do not retry it or guess its result. Tell the person that the conversation reached its tool-call budget, and that an owner or admin can raise the budget under Access in the Portal.";

/**
 * How a tool call reached the catalog: from the model, or from a Code Mode
 * script under the lease of its execution. An edit of a script ends by the
 * deadline that admission set for that execution.
 */
export type CatalogExecutionContext =
  | { readonly kind: "direct"; readonly executionLease?: never }
  | {
      readonly kind: "code_mode";
      readonly executionLease: HarnessCodeModeExecutionLease;
    };

export function executeNativeCatalogTool(
  authority: Parameters<typeof executeCatalogTool>[0],
  executionLease: HarnessCodeModeExecutionLease,
  name: string,
  inputJson: string,
  callId: string,
): Promise<AuthorizedHarnessToolResult> {
  return executeCatalogTool(
    authority,
    { kind: "code_mode", executionLease },
    name,
    inputJson,
    callId,
  );
}

export async function executeCatalogTool(
  authority: {
    readonly definitions: readonly HarnessToolDefinition[];
    readonly customConnectorOperations: readonly CustomConnectorCatalogEntry[];
    readonly listIntegrations: IntegrationList;
    readonly readAirtable?: (input: AirtableReadInput) => Promise<unknown>;
    readonly writeAirtable?: (input: AirtableWriteInput) => Promise<unknown>;
    readonly searchEmailMailbox: EmailMailboxSearch;
    readonly proposeEmailReply: EmailReplyPropose;
    readonly readEmailReplyDraft: EmailReplyDraftRead;
    readonly editEmailReplyDraft: EmailReplyDraftEdit;
    readonly readProductionPlan: ProductionPlanReadTool;
    readonly editProductionPlan: ProductionPlanEditTool;
    readonly proposeEmailOperational: EmailOperationalPropose;
    readonly proposeSlackMessage: SlackMessagePropose;
    readonly readWhatsAppSupport: WhatsAppSupportRead;
    readonly sendWhatsAppSupportReply: WhatsAppSupportReplySend;
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
    readonly readCounterSale?: CounterSaleReadTool;
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
    readonly searchFiles: FileSearch;
    readonly readFile: FileRead;
    readonly inspectMessageAttachment: MessageAttachmentInspect;
    readonly readMessageLink: MessageLinkRead;
    readonly readCustomConnector?: HarnessCustomConnectorRead;
    readonly proposeCustomConnectorWrite?: HarnessCustomConnectorWriteProposal;
    readonly proposeCommerceAction?: CommerceActionProposal;
    readonly proposeMerchantPlugin?: MerchantPluginProposal;
    readonly queryWorkspace: WorkspaceQuery;
    readonly readSavedBakeryRun?: (
      query: SavedBakeryRunQuery,
    ) => Promise<SavedBakeryRunResult>;
    readonly executeBakerySurface?: HarnessBakerySurfaceExecute;
    readonly executeCostsViewCommand?: import("../costs/view").HarnessCostsViewExecute;
    readonly proposeMemory?: HarnessMemoryProposal;
    readonly scheduleFollowUp?: HarnessFollowUpSchedule;
    readonly proposeSideCase?: HarnessSideCaseProposal;
    readonly requestPermission?: HarnessPermissionRequestTool;
    readonly claimCapability: HarnessCapabilityClaim;
  },
  execution: CatalogExecutionContext,
  name: string,
  inputJson: string,
  callId: string,
): Promise<AuthorizedHarnessToolResult> {
  if (
    callId.length === 0 ||
    !isSelectedCatalogToolName(authority.definitions, name)
  ) {
    if (name === "commerce_entity_context") {
      return CommerceContextToolResult.failure(
        "Tool request exceeded its accepted boundary",
      );
    }
    return authorizedRead(
      failedToolOutput("Tool request exceeded its accepted boundary"),
      "failed",
    );
  }
  let input: unknown;
  try {
    input = JSON.parse(inputJson);
  } catch {
    if (name === "commerce_entity_context") {
      return CommerceContextToolResult.failure("Tool input was not valid JSON");
    }
    return authorizedRead(
      failedToolOutput("Tool input was not valid JSON"),
      "failed",
    );
  }

  let codeModeValue: unknown;
  try {
    if (name === "commerce_entity_context") {
      const parsed = parseEntityContextArgs([input]);
      await claimDirectCapability(
        authority.claimCapability,
        callId,
        CAPABILITY_KEYS.commerceEntityPlaneContext,
      );
      return await CommerceContextToolResult.success(
        await authority.readEntityContext(parsed),
      );
    }
    codeModeValue = await executeDirectCatalogTool(
      authority,
      execution,
      name,
      input,
      callId,
    );
  } catch (error) {
    logCapabilityFailure(name, callId, error);
    let failure = CAPABILITY_FAILURE_TEXT;
    if (error instanceof ToolRequestError) {
      failure = error.message;
    } else {
      failure = registeredTool(name)?.unconfirmedFailure ?? failure;
    }
    if (error instanceof ToolRequestError && error.requestableRead !== null) {
      failure = await requestDeniedRead(
        authority.requestPermission,
        execution,
        error.requestableRead,
        failure,
      );
    }
    if (name === "commerce_entity_context") {
      return CommerceContextToolResult.failure(failure);
    }
    return authorizedRead(failedToolOutput(failure), "failed");
  }
  const output = JSON.stringify({
    output: boundedOutput(codeModeValue),
    success: true,
    code_mode_value: codeModeValue,
    metadata: null,
    process_trace: null,
  });
  if (registeredTool(name)?.effect === "surface") {
    return authorizedSurfaceEffect(
      output,
      readBakerySurfaceReceiptId(codeModeValue),
      bakerySurfaceToolSucceeded(codeModeValue) ? "succeeded" : "failed",
    );
  }
  const registered = registeredTool(name);
  if (registered?.effect === "receipt") {
    return authorizedProviderEffect(
      output,
      registered.readReceipt(codeModeValue),
    );
  }
  return authorizedRead(output);
}

/** What a catalog tool call can use: the dependencies of one turn. */
export type CatalogToolAuthority = Parameters<
  typeof executeDirectCatalogTool
>[0];

/**
 * One call of a tool from agent-tools/: the same order as the hand-written
 * cases. A missing handler fails first, then the arguments, then the
 * capability claim, so a refused call claims nothing.
 */
async function executeRegisteredTool(
  tool: RegisteredTool,
  authority: CatalogToolAuthority,
  execution: CatalogExecutionContext,
  input: unknown,
  callId: string,
): Promise<unknown> {
  if (tool.directOnly && execution.kind !== "direct") {
    throw new TypeError(`${tool.name} requires a direct call`);
  }
  const handler = tool.handler(authority);
  if (handler === undefined) {
    throw new Error(tool.unavailable);
  }
  const request = tool.parse(input);
  if (tool.selection.kind === "capability") {
    await claimDirectCapability(
      authority.claimCapability,
      callId,
      tool.selection.capability,
    );
  }
  return handler(request, {
    callId,
    execution,
    operationId: logicalToolOperationId(execution, callId),
  });
}

export async function executeDirectCatalogTool(
  authority: {
    readonly customConnectorOperations: readonly CustomConnectorCatalogEntry[];
    readonly listIntegrations: IntegrationList;
    readonly readAirtable?: (input: AirtableReadInput) => Promise<unknown>;
    readonly writeAirtable?: (input: AirtableWriteInput) => Promise<unknown>;
    readonly searchEmailMailbox: EmailMailboxSearch;
    readonly proposeEmailReply: EmailReplyPropose;
    readonly readEmailReplyDraft: EmailReplyDraftRead;
    readonly editEmailReplyDraft: EmailReplyDraftEdit;
    readonly readProductionPlan: ProductionPlanReadTool;
    readonly editProductionPlan: ProductionPlanEditTool;
    readonly proposeEmailOperational: EmailOperationalPropose;
    readonly proposeSlackMessage: SlackMessagePropose;
    readonly readWhatsAppSupport: WhatsAppSupportRead;
    readonly sendWhatsAppSupportReply: WhatsAppSupportReplySend;
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
    readonly readCounterSale?: CounterSaleReadTool;
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
    readonly searchFiles: FileSearch;
    readonly readFile: FileRead;
    readonly inspectMessageAttachment: MessageAttachmentInspect;
    readonly readMessageLink: MessageLinkRead;
    readonly readCustomConnector?: HarnessCustomConnectorRead;
    readonly proposeCustomConnectorWrite?: HarnessCustomConnectorWriteProposal;
    readonly proposeCommerceAction?: CommerceActionProposal;
    readonly proposeMerchantPlugin?: MerchantPluginProposal;
    readonly queryWorkspace: WorkspaceQuery;
    readonly readSavedBakeryRun?: (
      query: SavedBakeryRunQuery,
    ) => Promise<SavedBakeryRunResult>;
    readonly executeBakerySurface?: HarnessBakerySurfaceExecute;
    readonly executeCostsViewCommand?: import("../costs/view").HarnessCostsViewExecute;
    readonly proposeMemory?: HarnessMemoryProposal;
    readonly scheduleFollowUp?: HarnessFollowUpSchedule;
    readonly proposeSideCase?: HarnessSideCaseProposal;
    readonly requestPermission?: HarnessPermissionRequestTool;
    readonly claimCapability: HarnessCapabilityClaim;
  },
  execution: CatalogExecutionContext,
  name: HarnessToolDefinition["name"],
  input: unknown,
  callId: string,
): Promise<unknown> {
  const customConnectorOperation = findCustomConnectorOperation(
    authority.customConnectorOperations,
    name,
  );
  if (
    customConnectorOperation !== null &&
    isReadEntry(customConnectorOperation)
  ) {
    if (authority.readCustomConnector === undefined) {
      throw new Error("Custom connector reading is unavailable");
    }
    await claimDirectCapability(
      authority.claimCapability,
      callId,
      CAPABILITY_KEYS.customConnectorRead,
    );
    return authority.readCustomConnector(
      customConnectorOperation,
      input,
      `direct_tool:${callId}`,
    );
  }
  if (
    customConnectorOperation !== null &&
    isWriteEntry(customConnectorOperation)
  ) {
    if (authority.proposeCustomConnectorWrite === undefined) {
      throw new Error("Custom connector write proposals are unavailable");
    }
    await claimDirectCapability(
      authority.claimCapability,
      callId,
      CAPABILITY_KEYS.customConnectorWrite,
    );
    return authority.proposeCustomConnectorWrite(
      customConnectorOperation,
      input,
      `direct_tool:${callId}`,
    );
  }
  if (name === PERMISSION_REQUEST_TOOL_NAME) {
    // A request belongs to the turn's thread, so only the model calls it.
    if (execution.kind !== "direct") {
      throw new TypeError("request_permission requires a direct call");
    }
    if (authority.requestPermission === undefined) {
      throw new Error("Permission requests are unavailable");
    }
    return authority.requestPermission(parsePermissionRequestArgs(input));
  }
  const registered = registeredTool(name);
  if (registered !== undefined) {
    return executeRegisteredTool(
      registered,
      authority,
      execution,
      input,
      callId,
    );
  }
  if (!isStaticHarnessToolName(name)) {
    throw new Error("Tool request exceeded its accepted boundary");
  }
  switch (name) {
  }
}

async function claimDirectCapability(
  claimCapability: HarnessCapabilityClaim,
  callId: string,
  capability: HarnessCapabilityName,
): Promise<null> {
  const claimed = await claimCapability({
    callId,
    capability,
    boundary: "direct_tool",
  });
  if (!claimed.ok) {
    throw claimed.error.detail === "budget_exhausted"
      ? new CapabilityBudgetError(CAPABILITY_BUDGET_TEXT)
      : new Error(claimed.error.detail);
  }
  return null;
}

function failedToolOutput(detail: string): string {
  return JSON.stringify({
    output: boundedText(detail),
    success: false,
    code_mode_value: null,
    metadata: null,
    process_trace: null,
  });
}

async function authorizedRead(
  output: string,
  status: "succeeded" | "failed" = "succeeded",
): Promise<AuthorizedHarnessToolResult> {
  const value = await inlineToolOutput(output);
  return {
    kind: "read",
    output: value,
    authority: { kind: "read", resultDigest: value.digest },
    status,
  };
}

async function authorizedProviderEffect(
  output: string,
  receiptId: string,
): Promise<AuthorizedHarnessToolResult> {
  const value = await inlineToolOutput(output);
  return {
    kind: "provider_effect",
    output: value,
    authority: {
      kind: "provider_effect",
      receiptId,
      resultDigest: value.digest,
    },
    status: "succeeded",
  };
}

async function authorizedSurfaceEffect(
  output: string,
  receiptId: string,
  status: "succeeded" | "failed",
): Promise<AuthorizedHarnessToolResult> {
  const value = await inlineToolOutput(output);
  return {
    kind: "surface_effect",
    output: value,
    authority: {
      kind: "surface_effect",
      receiptId,
      resultDigest: value.digest,
    },
    status,
  };
}

async function inlineToolOutput(
  output: string,
): Promise<HarnessToolOutput> {
  return {
    kind: "inline",
    content: [{ kind: "text", text: output }],
    digest: await sha256Hex(output),
  };
}

function logicalToolOperationId(
  execution: CatalogExecutionContext,
  callId: string,
): string {
  return JSON.stringify([
    execution.kind === "code_mode" ? "code_mode" : "direct_tool",
    callId,
  ]);
}

function parseEntityContextArgs(
  args: readonly unknown[],
): CommerceContextRequest {
  if (
    args.length !== 1 ||
    !isRecord(args[0]) ||
    Object.keys(args[0]).length !== 1 ||
    !Object.hasOwn(args[0], "request")
  ) {
    throw new CommerceContextRequestError(
      "commerce_entity_context requires one request object. Correct the arguments before retrying.",
    );
  }
  const request = args[0].request;
  const parsed = parseCommerceGraphQuery({
    kind: "underclerk_context",
    ...(isRecord(request) ? withRecordLifecycle(request) : {}),
  });
  if (!parsed.ok || parsed.value.kind !== "underclerk_context") {
    throw new CommerceContextRequestError(
      "Invalid commerce_entity_context request. Follow the tool's request schema. A selector has exactly selectorId, revision and query; for entity_type_page, place traversal inside selector.query and at request.traversal. Correct the request before retrying; this is an input error.",
    );
  }
  if (parsed.value.selection.kind === "entity_seeds") {
    const first = parsed.value.selection.seeds[0];
    for (const seed of parsed.value.selection.seeds) {
      if (seed.origin !== first?.origin || seed.typeId !== first?.typeId) {
        throw new CommerceContextRequestError(
          "commerce_entity_context requires seeds of one origin and typeId per request. Read orders, payments and fulfillments in separate calls. Issue independent calls together; do not retry the mixed request.",
        );
      }
    }
  }
  if (
    parsed.value.traversal.maxDepth > 4 ||
    parsed.value.traversal.resultLimit > 100
  ) {
    throw new CommerceContextRequestError(
      "commerce_entity_context requires maxDepth at most 4 and resultLimit at most 100. Correct the limits before retrying.",
    );
  }
  return parsed.value;
}

/**
 * The state of a record, such as an order's "fulfilled", is the `lifecycle`
 * attribute that the Portal lists show. A request that leaves it out of its
 * allowlist still gets it, so the agent can say what a person sees. The
 * sensitivity ceiling and the person's grants still apply to it.
 */
const RECORD_LIFECYCLE_ATTRIBUTE_ID = "lifecycle";

function withRecordLifecycle(
  request: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = request.allowedAttributeIds;
  if (
    !Array.isArray(allowed) ||
    allowed.includes(RECORD_LIFECYCLE_ATTRIBUTE_ID)
  )
    return request;
  return {
    ...request,
    allowedAttributeIds: [...allowed, RECORD_LIFECYCLE_ATTRIBUTE_ID],
  };
}

function boundedOutput(value: unknown): string {
  let serialized: string;
  try {
    serialized = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return "Code Mode returned a non-serializable result";
  }
  return boundedText(serialized ?? "null");
}

function boundedText(value: string): string {
  const bytes = ENCODER.encode(value);
  if (bytes.byteLength <= MAX_CODE_MODE_OUTPUT_BYTES) {
    return value;
  }
  const prefix = new TextDecoder().decode(
    bytes.slice(0, MAX_CODE_MODE_OUTPUT_BYTES),
  );
  return `${prefix}\n[output truncated from ${bytes.byteLength} bytes]`;
}

function logCapabilityFailure(
  tool: HarnessToolDefinition["name"],
  callId: string,
  error: unknown,
): void {
  console.warn("embedded_harness.capability_failed", {
    tool,
    callId,
    detail: errorMessage(error),
  });
}
