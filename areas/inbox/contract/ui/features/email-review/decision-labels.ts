/**
 * The labels of an email reply decision, one look in every place: the
 * mailbox page, the Inbox conversation and the draft card in a chat. A place
 * that can edit the draft shows Edit between them. This file is a public file
 * of the inbox area, so the chat surface can import it.
 */
export const EMAIL_REPLY_DECISION = {
  sendLabel: "Approve and send",
  discardLabel: "Reject",
} as const;

/** A self-test goes to the address of the person who approves it. */
export const SELF_TEST_SEND_LABEL =
  "Confirm this is my address and send self-test";
