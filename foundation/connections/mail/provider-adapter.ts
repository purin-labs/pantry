import type * as Gmail from "./gmail-adapter";
import type { GmailAuthorizationProduct } from "./gmail-authorization";

type GmailMailProducts = {
  readonly full_mailbox_pilot: {
    readonly product: "full_mailbox_pilot";
    readonly reads: {
      readonly readProfile: typeof Gmail.gmailGetProfile;
      readonly browseInbox: typeof Gmail.gmailBrowseInbox;
      readonly readInboxReferences: typeof Gmail.gmailReadInboxReferences;
      readonly readConversation: typeof Gmail.gmailReadInboxThread;
      readonly readThreadHeadline: typeof Gmail.gmailReadThreadHeadline;
      readonly readMessageMetadata: typeof Gmail.gmailGetMessageMetadata;
      readonly readMessage: typeof Gmail.gmailGetMessageContent;
      readonly readAttachment: typeof Gmail.gmailGetAttachment;
      readonly searchMessages: typeof Gmail.gmailSearchMessages;
      readonly findSubmissionEvidence: typeof Gmail.gmailFindByRfcMessageId;
    };
    readonly observation: {
      readonly startWatch: typeof Gmail.gmailStartWatch;
      readonly stopWatch: typeof Gmail.gmailStopWatch;
      readonly readInboxAdditions: typeof Gmail.gmailListInboxAdditions;
      readonly readInboxHistoryPage: typeof Gmail.gmailReadInboxHistoryPage;
    };
    readonly drafts: {
      readonly create: typeof Gmail.gmailCreateDraft;
      readonly read: typeof Gmail.gmailGetDraft;
      readonly replaceBody: typeof Gmail.gmailUpdateDraft;
      readonly dispose: typeof Gmail.gmailDeleteDraft;
      readonly findCreationEvidence: typeof Gmail.gmailFindDraftByRfcMessageId;
    };
    readonly submission: {
      readonly sendReply: typeof Gmail.gmailSendRaw;
      readonly sendMessage: typeof Gmail.gmailSendRawMessage;
    };
  };
  readonly send_only: {
    readonly product: "send_only";
    readonly reads?: never;
    readonly observation?: never;
    readonly drafts?: never;
    readonly submission: {
      readonly sendMessage: typeof Gmail.gmailSendRawMessage;
      readonly sendReply?: never;
    };
  };
};

type MailProviderAdapterByProvider = {
  readonly gmail: {
    readonly provider: "gmail";
    readonly products: {
      readonly [
        Product in GmailAuthorizationProduct
      ]: GmailMailProducts[Product];
    };
  };
};

export type MailIntegrationProvider = keyof MailProviderAdapterByProvider;

export type MailProviderAdapter<
  Provider extends MailIntegrationProvider = MailIntegrationProvider,
> = MailProviderAdapterByProvider[Provider];
