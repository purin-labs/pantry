/**
 * The delivery ids of the Slack card of one device incident (Plan 85). The
 * alert sweep names its notice and its update with them, and the Slack
 * delivery reads them back.
 */

const NOTICE_PREFIX = "device_alert_notice_";
const UPDATE_PREFIX = "device_alert_update_";

export function deviceAlertNoticeDeliveryId(alertId: string): string {
  return `${NOTICE_PREFIX}${alertId}`;
}

export function deviceAlertUpdateDeliveryId(alertId: string): string {
  return `${UPDATE_PREFIX}${alertId}`;
}

export function isDeviceAlertDelivery(deliveryId: string): boolean {
  return (
    deliveryId.startsWith(NOTICE_PREFIX) || deliveryId.startsWith(UPDATE_PREFIX)
  );
}

/** The notice that an update changes, if this delivery is an update. */
export function deviceAlertNoticeOfUpdate(deliveryId: string): string | null {
  return deliveryId.startsWith(UPDATE_PREFIX)
    ? `${NOTICE_PREFIX}${deliveryId.slice(UPDATE_PREFIX.length)}`
    : null;
}
