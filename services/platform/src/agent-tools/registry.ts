import { createToolRegistry } from "@purin-labs/agent-tools/catalog/tool-registry";
import type { RegisteredTool } from "@purin-labs/agent-tools/define-tool";
import { SURFACE_TOOL_LIST } from "./bakery/surface";
import {
  emailMailboxSearch,
  emailOperationalProposal,
  emailReplyDraftEdit,
  emailReplyDraftRead,
  emailReplyProposal,
  whatsAppSupportRead,
  whatsAppSupportReplySend,
} from "@purin-labs/area-inbox/server/agent-tools/channels/channels";
import {
  emailDraftEdit,
  emailDraftRead,
} from "@purin-labs/area-inbox/server/agent-tools/channels/email-draft";
import {
  productDescriptionDraftEdit,
  productDescriptionDraftRead,
} from "./commerce/description-draft";
import { commerceEntityContext } from "./commerce/entity-context";
import {
  counterSaleRead,
  orderQueueAdvance,
  orderQueueRead,
  soldOutMark,
  soldOutRead,
} from "@purin-labs/area-cafe/server/agent-tools/commerce/order-queue";
import { paymentsRead } from "./commerce/payments";
import {
  campaignBriefProposal,
  commerceActionProposal,
  configurationProposal,
  menuPublicationProposal,
  merchantPluginProposal,
  orderRefundProposal,
  stockActionProposal,
} from "./commerce/proposals";
import { REGISTER_VIEW_TOOLS } from "@purin-labs/area-cafe/server/agent-tools/commerce/register-view";
import { merchantReport } from "./commerce/reports";
import { COSTS_VIEW_TOOLS } from "./costs/view";
import {
  devicePause,
  deviceProposal,
  deviceRead,
  deviceSnapshotRead,
} from "@purin-labs/area-devices/server/agent-tools/devices/devices";
import {
  menuBoardArchive,
  menuBoardComment,
  menuBoardCreate,
  menuBoardEdit,
  menuBoardHistory,
  menuBoardRead,
  menuBoardStack,
  menuDraftEdit,
  menuDraftRead,
  menuPriceProposal,
} from "@purin-labs/area-cafe/server/agent-tools/drafts/drafts";
import {
  fileRead,
  fileSearch,
  workspaceQuery,
} from "@purin-labs/agent-tools/files/files";
import {
  airtableApiRead,
  airtableApiWrite,
  integrationList,
} from "@purin-labs/area-integrations/server/agent-tools/integrations/integrations";
import {
  jevFeaturesManage,
  jevFeaturesRead,
} from "@purin-labs/area-integrations/server/agent-tools/jev/jev";
import {
  bakeProposal,
  bakeRead,
  bakeRunPause,
  bakeRunRead,
  bakeStockLevelProposal,
  costsPlanSave,
  costsRead,
  costsSheetEdit,
  lotCostSave,
  PASTRY_BENCH_VIEW_TOOLS,
  productionPlanEdit,
  productionPlanRead,
  recipeRead,
  recipeSave,
  recipeWorkflowProposal,
  recipeWorkflowRead,
  savedBakeryRunRead,
  supplierCreate,
  supplierRead,
  supplyCostSave,
  workflowCanvasMove,
  workflowCanvasRead,
} from "./kitchen/tools";
import {
  messageAttachmentInspect,
  messageLinkRead,
} from "@purin-labs/agent-tools/messages/messages";
import { slackMessageProposal } from "./slack/slack";
import {
  followUp,
  memoryProposal,
  sideCaseProposal,
} from "@purin-labs/agent-tools/turn/turn";

/**
 * The one list of the agent tools: each family gives its tools, and this list
 * gives them their place. The order is the order of the model definitions.
 * The session pins a digest of them, so a tool keeps its place: add a new
 * tool at the end of its group, and move none.
 *
 * A turn offers the tools in three passes over this list: the tools that a
 * capability selects, then the tools that a page command selects, then the
 * tools of the turn's origin.
 */
export const TOOLS = [
  // The tools that a capability selects.
  savedBakeryRunRead,
  airtableApiRead,
  airtableApiWrite,
  integrationList,
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
  commerceEntityContext,
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
  deviceRead,
  deviceSnapshotRead,
  devicePause,
  deviceProposal,
  jevFeaturesRead,
  jevFeaturesManage,
  merchantReport,
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
  campaignBriefProposal,
  configurationProposal,
  commerceActionProposal,
  menuPublicationProposal,
  orderRefundProposal,
  stockActionProposal,
  merchantPluginProposal,
  fileSearch,
  fileRead,
  workspaceQuery,
  messageAttachmentInspect,
  messageLinkRead,
  bakeRead,
  bakeProposal,
  bakeStockLevelProposal,
  bakeRunRead,
  bakeRunPause,
  // The tools that a page command selects (Plan 87): the Kitchen workspace,
  // Costs & margins, the Pastry Bench and Café › Register.
  ...SURFACE_TOOL_LIST,
  ...COSTS_VIEW_TOOLS,
  ...PASTRY_BENCH_VIEW_TOOLS,
  ...REGISTER_VIEW_TOOLS,
  // The tools that a turn offers by its origin.
  memoryProposal,
  followUp,
  sideCaseProposal,
] as const;

export const TOOL_REGISTRY = createToolRegistry(TOOLS);

type Tool = (typeof TOOLS)[number];

type ServicesOf<T> =
  T extends RegisteredTool<string, string, infer Services> ? Services : never;

/**
 * What a turn gives to the tools: the services of each family, under the
 * family's name. Each family's area declares the type of its services. The
 * Session gives the whole set, so a tool that the model sees has a handler.
 */
export type ToolServices = {
  readonly [Family in Tool["family"]]: ServicesOf<
    Extract<Tool, { readonly family: Family }>
  >;
};

/** The services of a host that runs a part of the tools, for example a check. */
export type PartialToolServices = {
  readonly [Family in keyof ToolServices]?: Partial<ToolServices[Family]>;
};
