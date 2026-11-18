import type { EmailReplyDisposition } from "../actors/connector-email";

/**
 * What the mailbox does with the reply that its agent chose (Plan 89 step 5).
 *
 * The agent reads text that a person outside the Organisation wrote, and that
 * text can ask for a direct reply. So the model's choice alone never sends a
 * reply with no person. A direct reply needs two facts that trusted code
 * holds: the message came from a verified contact, and the turn read no
 * record but the admitted messages and the accepted Memory of that contact.
 * Any other reply waits for a person as a draft.
 */
export function mailboxReplyDisposition(
  input: Readonly<{
    chosen: EmailReplyDisposition;
    /** The triggering message is bound to a current contact verification. */
    verifiedSender: boolean;
    /** The turn read commerce records or evidence of another thread. */
    readOtherRecords: boolean;
  }>,
): EmailReplyDisposition {
  return input.chosen === "reply_now" &&
    input.verifiedSender &&
    !input.readOtherRecords
    ? "reply_now"
    : "approval_required";
}
