import type {
  IntegrationAccountReference,
} from "@purin-labs/authority/access-control/integration-discovery";
import type {
  EmailDraftEditRequest,
  EmailDraftRead,
} from "../../actors/email-draft";
import type { EmailSelfTestRequest } from "../../data/email-self-test";
import type { EmailReplyCitation } from "../../mail-inbox/reply-sources";
import type { CatalogExecutionContext } from "@purin-labs/agent-tools/catalog/execute";
import { defineToolFamily } from "@purin-labs/agent-tools/define-tool";
import { ToolRequestError } from "@purin-labs/agent-tools/errors";
import type { PreparedEffect } from "@purin-labs/agent-tools/tool-effect";

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
) => Promise<PreparedEffect>;

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
) => Promise<PreparedEffect>;

type EmailOperationalPropose = (
  request: HarnessEmailOperationalPropose,
) => Promise<PreparedEffect>;

type WhatsAppSupportRead = (
  request: HarnessWhatsAppSupportRead,
) => Promise<HarnessWhatsAppSupportInbox>;

type WhatsAppSupportReplySend = (
  request: HarnessWhatsAppSupportReplySend,
) => Promise<PreparedEffect>;

type EmailDraftReadTool = () => Promise<EmailDraftRead>;

type EmailDraftEditTool = (
  request: EmailDraftEditRequest,
  operationId: string,
  boundary: CatalogExecutionContext,
) => Promise<PreparedEffect>;

/** What a turn gives to the mail and WhatsApp tools. */
export type ChannelToolServices = {
  readonly searchEmailMailbox: EmailMailboxSearch;
  readonly proposeEmailReply: EmailReplyPropose;
  readonly readEmailReplyDraft: EmailReplyDraftRead;
  readonly editEmailReplyDraft: EmailReplyDraftEdit;
  readonly proposeEmailOperational: EmailOperationalPropose;
  readonly readWhatsAppSupport: WhatsAppSupportRead;
  readonly sendWhatsAppSupportReply: WhatsAppSupportReplySend;
  readonly readEmailDraft: EmailDraftReadTool;
  readonly editEmailDraft: EmailDraftEditTool;
};

export const defineChannelTool =
  defineToolFamily<ChannelToolServices>()("channels");
