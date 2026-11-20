import { cardDeliveryIds } from "./card-delivery-ids";
import { workspacePortalUrl } from "./portal-links";
import type { Env } from "../env";

/**
 * One Slack card for one device incident (Plan 85). A reconnect updates the
 * same card. The text holds only names that a person confirmed and closed fault
 * codes, as plain text, so that a device cannot write to the channel.
 */

const DEVICE_ALERT_CARD = cardDeliveryIds("device_alert");

export function deviceAlertNoticeDeliveryId(alertId: string): string {
  return DEVICE_ALERT_CARD.notice(alertId);
}

export function deviceAlertUpdateDeliveryId(alertId: string): string {
  return DEVICE_ALERT_CARD.update(alertId);
}

export function isDeviceAlertDelivery(deliveryId: string): boolean {
  return DEVICE_ALERT_CARD.isCard(deliveryId);
}

/** The notice that an update changes, if this delivery is an update. */
export function deviceAlertNoticeOfUpdate(deliveryId: string): string | null {
  return DEVICE_ALERT_CARD.noticeOfUpdate(deliveryId);
}

export function deviceAlertCardBlocks(
  text: string,
  devicesUrl: string | null,
): readonly Record<string, unknown>[] {
  return [
    { type: "section", text: { type: "plain_text", text, emoji: false } },
    ...(devicesUrl === null
      ? []
      : [
          {
            type: "actions",
            elements: [
              {
                type: "button",
                action_id: "device_alert_open",
                text: { type: "plain_text", text: "Open Devices" },
                url: devicesUrl,
              },
            ],
          },
        ]),
  ];
}

export function devicesPortalUrl(
  env: Env,
  address: Readonly<{ organisationHandle: string; workspaceHandle: string }>,
): string {
  return workspacePortalUrl(env, address, "devices");
}
