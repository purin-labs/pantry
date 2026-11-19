import type { HarnessToolDefinition } from "./catalog/types";
import { COSTS_VIEW_TOOLS } from "./costs/view";
import { PASTRY_BENCH_VIEW_TOOLS } from "./kitchen/pastry-bench";
import { REGISTER_VIEW_TOOLS } from "./commerce/register-view";
import { modelToolDefinition, type RegisteredTool } from "./define-tool";
import {
  counterSaleRead,
  orderQueueAdvance,
  orderQueueRead,
  soldOutMark,
  soldOutRead,
} from "./commerce/order-queue";
import { paymentsRead } from "./commerce/payments";
import {
  devicePause,
  deviceProposal,
  deviceRead,
  deviceSnapshotRead,
} from "./devices/devices";
import { jevFeaturesManage, jevFeaturesRead } from "./jev/jev";
import {
  emailMailboxSearch,
  emailOperationalProposal,
  emailReplyDraftEdit,
  emailReplyDraftRead,
  emailReplyProposal,
  productionPlanEdit,
  productionPlanRead,
  slackMessageProposal,
  whatsAppSupportRead,
  whatsAppSupportReplySend,
} from "./channels/channels";
import {
  recipeWorkflowProposal,
  recipeWorkflowRead,
} from "./kitchen/recipe-workflow";
import { followUp, memoryProposal, sideCaseProposal } from "./turn/turn";
import { SURFACE_TOOL_LIST } from "./bakery/surface";
import { savedBakeryRunRead } from "./kitchen/saved-runs";
import {
  airtableApiRead,
  airtableApiWrite,
  integrationList,
} from "./integrations/integrations";
import { merchantReport } from "./commerce/reports";
import {
  campaignBriefProposal,
  commerceActionProposal,
  configurationProposal,
  menuPublicationProposal,
  merchantPluginProposal,
  orderRefundProposal,
  stockActionProposal,
} from "./commerce/proposals";
import { fileRead, fileSearch, workspaceQuery } from "./files/files";
import { messageAttachmentInspect, messageLinkRead } from "./messages/messages";
import {
  emailDraftEdit,
  emailDraftRead,
  menuBoardComment,
  menuBoardEdit,
  menuBoardHistory,
  menuBoardCreate,
  menuBoardArchive,
  menuBoardRead,
  menuBoardStack,
  menuDraftEdit,
  menuDraftRead,
  menuPriceProposal,
  productDescriptionDraftEdit,
  productDescriptionDraftRead,
  workflowCanvasMove,
  workflowCanvasRead,
} from "./drafts/drafts";
import {
  costsPlanSave,
  costsRead,
  costsSheetEdit,
  lotCostSave,
  supplyCostSave,
} from "./kitchen/costs";
import { recipeRead, recipeSave } from "./kitchen/recipes";
import { supplierCreate, supplierRead } from "./kitchen/suppliers";

/**
 * The agent tools that have moved out of `actors/harness-tool-catalog.ts`
 * (Refactor 10, step 1). The order is the order of the model definitions in
 * the catalog: the session pins a digest of that list.
 */
/** The tools that the catalog lists where the order queue tools were. */
export const COMMERCE_TOOLS = [
  orderQueueRead,
  paymentsRead,
  orderQueueAdvance,
  soldOutRead,
  soldOutMark,
  recipeRead,
  recipeSave,
  costsRead,
  supplyCostSave,
  lotCostSave,
  costsPlanSave,
  costsSheetEdit,
  supplierRead,
  supplierCreate,
  recipeWorkflowRead,
  recipeWorkflowProposal,
  counterSaleRead,
] as const;

/** The tools that the catalog lists where the device tools were. */
export const DEVICE_TOOLS = [
  deviceRead,
  deviceSnapshotRead,
  devicePause,
  deviceProposal,
] as const;

/** The Jev settings tools, after the device tools (Plan 88). */
export const JEV_TOOLS = [jevFeaturesRead, jevFeaturesManage] as const;

/** The tools that the catalog lists where the draft tools were. */
export const DRAFT_TOOLS = [
  workflowCanvasRead,
  workflowCanvasMove,
  productDescriptionDraftRead,
  productDescriptionDraftEdit,
  menuDraftRead,
  menuDraftEdit,
  menuBoardRead,
  menuBoardEdit,
  menuBoardComment,
  menuBoardHistory,
  menuBoardCreate,
  menuBoardArchive,
  menuBoardStack,
  menuPriceProposal,
  emailDraftRead,
  emailDraftEdit,
] as const;

/** The tools that the catalog lists where the mail and channel tools were. */
export const CHANNEL_TOOLS = [
  emailMailboxSearch,
  emailReplyProposal,
  emailReplyDraftRead,
  emailReplyDraftEdit,
  productionPlanRead,
  productionPlanEdit,
  emailOperationalProposal,
  slackMessageProposal,
  whatsAppSupportRead,
  whatsAppSupportReplySend,
] as const;

/** The catalog slot of the saved Kitchen run read, first in the catalog. */
export const SAVED_RUN_TOOLS = [savedBakeryRunRead] as const;

/** The catalog slot of Airtable and the integration list. */
export const INTEGRATION_TOOLS = [
  airtableApiRead,
  airtableApiWrite,
  integrationList,
] as const;

/** The catalog slot of the merchant report, after the device tools. */
export const REPORT_TOOLS = [merchantReport] as const;

/** The catalog slot of the commerce proposals, after the draft tools. */
export const PROPOSAL_TOOLS = [
  campaignBriefProposal,
  configurationProposal,
  commerceActionProposal,
  menuPublicationProposal,
  orderRefundProposal,
  stockActionProposal,
  merchantPluginProposal,
] as const;

/** The catalog slot of the file and workspace reads. */
export const FILE_TOOLS = [fileSearch, fileRead, workspaceQuery] as const;

/** The catalog slot of the message attachment and link reads, last in the catalog. */
export const MESSAGE_TOOLS = [
  messageAttachmentInspect,
  messageLinkRead,
] as const;

/**
 * The tools that a turn offers by its origin, after the Kitchen tools,
 * in this order.
 */
export const TURN_TOOLS = [memoryProposal, followUp, sideCaseProposal] as const;

/**
 * The surface tools, after the catalog tools: the Kitchen tools, then
 * the Costs & margins view commands (Plan 87 phase 4).
 */
export const SURFACE_TOOLS = [
  ...SURFACE_TOOL_LIST,
  ...COSTS_VIEW_TOOLS,
  ...PASTRY_BENCH_VIEW_TOOLS,
  ...REGISTER_VIEW_TOOLS,
];

export const TOOLS = [
  ...SURFACE_TOOLS,
  ...TURN_TOOLS,
  ...SAVED_RUN_TOOLS,
  ...INTEGRATION_TOOLS,
  ...REPORT_TOOLS,
  ...PROPOSAL_TOOLS,
  ...FILE_TOOLS,
  ...MESSAGE_TOOLS,
  ...CHANNEL_TOOLS,
  ...COMMERCE_TOOLS,
  ...DEVICE_TOOLS,
  ...JEV_TOOLS,
  ...DRAFT_TOOLS,
] as const;

export type RegisteredToolName = (typeof TOOLS)[number]["name"];

const TOOL_BY_NAME: ReadonlyMap<string, RegisteredTool> = new Map(
  TOOLS.map((tool) => [tool.name, tool]),
);

export function registeredTool(name: string): RegisteredTool | undefined {
  return TOOL_BY_NAME.get(name);
}

export function isRegisteredToolName(name: string): name is RegisteredToolName {
  return TOOL_BY_NAME.has(name);
}

/** The model definitions of one group, in its order. */
export function registeredModelDefinitions<Name extends RegisteredToolName>(
  group: readonly RegisteredTool<Name>[],
): readonly (HarnessToolDefinition & { readonly name: Name })[] {
  return group.map(modelToolDefinition);
}
