/**
 * The delivery id of the Slack card that tells the operations channel that
 * new mail of one mailbox waits for its AI model. The wait key names the
 * model and its review, and the id ends with the mailbox, so that the
 * card's button opens that mailbox's settings.
 */

const PREFIX = "mail_model_notice_";
const WAIT_KEY_LENGTH = 16;

export function mailModelNoticeDeliveryId(
  integrationAccountId: string,
  waitKey: string,
): string {
  if (waitKey.length !== WAIT_KEY_LENGTH)
    throw new TypeError("A mail model wait key has 16 characters.");
  return `${PREFIX}${waitKey}_${integrationAccountId}`;
}

/** The mailbox that a card names, or null for another delivery. */
export function mailModelNoticeMailbox(deliveryId: string): string | null {
  if (!deliveryId.startsWith(PREFIX)) return null;
  const mailbox = deliveryId.slice(PREFIX.length + WAIT_KEY_LENGTH + 1);
  return mailbox === "" ? null : mailbox;
}
