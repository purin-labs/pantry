import type { MailInboxCommand } from "./mail-inbox.ts";
import type {
  MailInboxWork,
  MailWorkReplyState,
  MailWorkAssignment,
  MailInboxReplyPreview,
} from "./mail-work.ts";

// @ts-expect-error Work reads require the selected thread.
const missingThread: MailInboxCommand = {
  kind: "work",
  integrationAccountId: "account",
};
const sent = { kind: "sent", providerMessageId: "message", sentAt: 1 } as const;
// @ts-expect-error An unresolved send cannot carry a confirmed receipt through a spread.
const mixedReceipt: MailWorkReplyState = {
  ...sent,
  kind: "send_indeterminate",
  rfcMessageId: "message@example.test",
};
// @ts-expect-error A confirmed send requires its provider receipt.
const missingReceipt: MailWorkReplyState = { kind: "sent" };
// @ts-expect-error Unlinked conversations cannot carry Case state.
const mixedWork: MailInboxWork = { kind: "unlinked", caseId: "case" };
// @ts-expect-error An assignment cannot be settled before starting.
const missingStart: MailWorkAssignment = {
  kind: "failed",
  assignmentId: "assignment",
  settledAt: 1,
};
// @ts-expect-error Missing drafts cannot carry cached content.
const mixedPreview: MailInboxReplyPreview = {
  kind: "proposal_missing",
  body: "old draft",
};
void missingThread;
void mixedReceipt;
void missingReceipt;
void mixedWork;
void missingStart;
void mixedPreview;
