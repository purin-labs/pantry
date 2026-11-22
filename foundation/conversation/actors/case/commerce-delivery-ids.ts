/**
 * The delivery identities of the two Case outputs of a commerce action: the
 * approval notice and the outcome. The Case makes them, and a channel reads
 * them to find the action of a delivery.
 */

const NOTICE_DELIVERY_PREFIX = "delivery_commerce_notice_";
const OUTCOME_DELIVERY_PREFIX = "delivery_commerce_";

/** The delivery identity of the approval notice of one action. */
export function commerceApprovalNoticeDeliveryId(actionNonce: string): string {
  return `${NOTICE_DELIVERY_PREFIX}${actionNonce}`;
}

/** The action nonce of an approval notice, or null for any other delivery. */
export function commerceApprovalNoticeNonce(deliveryId: string): string | null {
  return deliveryId.startsWith(NOTICE_DELIVERY_PREFIX)
    ? deliveryId.slice(NOTICE_DELIVERY_PREFIX.length)
    : null;
}

/** The action nonce of an outcome, or null for any other delivery. */
export function commerceOutcomeNonce(deliveryId: string): string | null {
  return deliveryId.startsWith(OUTCOME_DELIVERY_PREFIX) &&
    !deliveryId.startsWith(NOTICE_DELIVERY_PREFIX)
    ? deliveryId.slice(OUTCOME_DELIVERY_PREFIX.length)
    : null;
}

/** The delivery identity of the outcome of one action. */
export function commerceOutcomeDeliveryId(actionNonce: string): string {
  return `${OUTCOME_DELIVERY_PREFIX}${actionNonce}`;
}
