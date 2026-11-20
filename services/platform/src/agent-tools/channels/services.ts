import type { IntegrationAccountReference } from "../../access-control/integration-discovery";
import type { EmailSelfTestRequest } from "../../data/email-self-test";
import type { EmailReplyCitation } from "../../mail-inbox/reply-sources";
import type { CatalogExecutionContext } from "../catalog/execute";
import { defineToolFamily } from "../define-tool";
import { ToolRequestError } from "../errors";

/**
 * A Slack draft the model can correct, such as one for a channel that is not
 * connected. Its message reaches the model, so it names no channel or account.
 */
export class SlackDraftRequestError extends ToolRequestError {}

/**
 * Plan 40D: a reply draft request the model can correct, such as a read from
 * a chat that did not read the reply's sources. Its message reaches the
 * model, so it names no source, Project, person or reply text.
 */
export class EmailReplyDraftRequestError extends ToolRequestError {}

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

type EmailMailboxSearch = (
  request: HarnessEmailMailboxSearch,
) => Promise<HarnessEmailMailboxSearchResult>;

type EmailReplyPropose = (
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

type EmailReplyDraftRead = (
  request: HarnessEmailReplyDraftRead,
) => Promise<HarnessEmailReplyDraft>;

type EmailReplyDraftEdit = (
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

type ProductionPlanReadTool = (
  request: HarnessProductionPlanRead,
) => Promise<HarnessProductionPlan>;

type ProductionPlanEditTool = (
  request: HarnessProductionPlanEdit,
  operationId: string,
  boundary: CatalogExecutionContext,
) => Promise<HarnessProductionPlan>;

/**
 * Plan 40D: a plan request that the model can correct, such as a request that
 * no longer waits for acceptance. Its message reaches the model.
 */
export class ProductionPlanRequestError extends ToolRequestError {}

type EmailOperationalPropose = (
  request: HarnessEmailOperationalPropose,
) => Promise<HarnessEmailOperationalProposalReceipt>;

type SlackMessagePropose = (
  request: HarnessSlackMessagePropose,
) => Promise<HarnessSlackMessageProposalReceipt>;

type WhatsAppSupportRead = (
  request: HarnessWhatsAppSupportRead,
) => Promise<HarnessWhatsAppSupportInbox>;

type WhatsAppSupportReplySend = (
  request: HarnessWhatsAppSupportReplySend,
) => Promise<HarnessWhatsAppSupportReplyReceipt>;

/** What a turn gives to the mail, production plan, Slack and WhatsApp tools. */
export type ChannelToolServices = {
  readonly searchEmailMailbox: EmailMailboxSearch;
  readonly proposeEmailReply: EmailReplyPropose;
  readonly readEmailReplyDraft: EmailReplyDraftRead;
  readonly editEmailReplyDraft: EmailReplyDraftEdit;
  readonly readProductionPlan?: ProductionPlanReadTool;
  readonly editProductionPlan?: ProductionPlanEditTool;
  readonly proposeEmailOperational: EmailOperationalPropose;
  readonly proposeSlackMessage: SlackMessagePropose;
  readonly readWhatsAppSupport: WhatsAppSupportRead;
  readonly sendWhatsAppSupportReply: WhatsAppSupportReplySend;
};

export const defineChannelTool =
  defineToolFamily<ChannelToolServices>()("channels");
