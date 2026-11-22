import {
  gmailGetProfile,
  gmailBrowseInbox,
  gmailReadInboxReferences,
  gmailReadInboxThread,
  gmailReadThreadHeadline,
  gmailGetMessageMetadata,
  gmailGetMessageContent,
  gmailGetAttachment,
  gmailSearchMessages,
  gmailFindByRfcMessageId,
  gmailFindDraftByRfcMessageId,
  gmailStartWatch,
  gmailStopWatch,
  gmailListInboxAdditions,
  gmailReadInboxHistoryPage,
  gmailCreateDraft,
  gmailGetDraft,
  gmailUpdateDraft,
  gmailDeleteDraft,
  gmailSendRaw,
  gmailSendRawMessage,
} from "./gmail-adapter";
import type { MailProviderAdapter } from "./provider-adapter";

/**
 * The Gmail calls of each authorization product, as the mail adapter of the
 * provider catalogue. It is below the inbox code, so a mailbox read needs no
 * import of the catalogue.
 */
export const gmailMailAdapter: MailProviderAdapter<"gmail"> = {
  provider: "gmail",
  products: {
    full_mailbox_pilot: {
      product: "full_mailbox_pilot",
      reads: {
        readProfile: gmailGetProfile,
        browseInbox: gmailBrowseInbox,
        readInboxReferences: gmailReadInboxReferences,
        readConversation: gmailReadInboxThread,
        readThreadHeadline: gmailReadThreadHeadline,
        readMessageMetadata: gmailGetMessageMetadata,
        readMessage: gmailGetMessageContent,
        readAttachment: gmailGetAttachment,
        searchMessages: gmailSearchMessages,
        findSubmissionEvidence: gmailFindByRfcMessageId,
      },
      observation: {
        startWatch: gmailStartWatch,
        stopWatch: gmailStopWatch,
        readInboxAdditions: gmailListInboxAdditions,
        readInboxHistoryPage: gmailReadInboxHistoryPage,
      },
      drafts: {
        create: gmailCreateDraft,
        read: gmailGetDraft,
        replaceBody: gmailUpdateDraft,
        dispose: gmailDeleteDraft,
        findCreationEvidence: gmailFindDraftByRfcMessageId,
      },
      submission: {
        sendReply: gmailSendRaw,
        sendMessage: gmailSendRawMessage,
      },
    },
    send_only: {
      product: "send_only",
      submission: { sendMessage: gmailSendRawMessage },
    },
  },
};

/** The mail calls of a connected mailbox: reads, watch, drafts and send. */
export const GMAIL_MAILBOX = gmailMailAdapter.products.full_mailbox_pilot;
