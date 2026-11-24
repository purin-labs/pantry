/**
 * The delivery ids of the Slack card that tells the operations channel that
 * new mail of one mailbox waits for its AI model, and of the change to that
 * card when mail goes to the model again. The wait key names the model and
 * its review, and the id ends with the mailbox, so that the card's button
 * opens that mailbox's settings.
 */

const PREFIX = "mail_model_notice_";
const UPDATE_PREFIX = "mail_model_update_";
const WAIT_KEY_LENGTH = 16;

export function mailModelNoticeDeliveryId(
  integrationAccountId: string,
  waitKey: string,
): string {
  if (waitKey.length !== WAIT_KEY_LENGTH)
    throw new TypeError("A mail model wait key has 16 characters.");
  return `${PREFIX}${waitKey}_${integrationAccountId}`;
}

/** The change of the card that this notice posted. */
export function mailModelNoticeUpdateDeliveryId(
  noticeDeliveryId: string,
): string {
  return `${UPDATE_PREFIX}${noticeDeliveryId.slice(PREFIX.length)}`;
}

/** The mailbox that a notice names, or null for another delivery. */
export function mailModelNoticeMailbox(deliveryId: string): string | null {
  if (!deliveryId.startsWith(PREFIX)) return null;
  const mailbox = deliveryId.slice(PREFIX.length + WAIT_KEY_LENGTH + 1);
  return mailbox === "" ? null : mailbox;
}

/** The notice that this delivery changes, if it is a change. */
export function mailModelNoticeOfUpdate(deliveryId: string): string | null {
  return deliveryId.startsWith(UPDATE_PREFIX)
    ? `${PREFIX}${deliveryId.slice(UPDATE_PREFIX.length)}`
    : null;
}
