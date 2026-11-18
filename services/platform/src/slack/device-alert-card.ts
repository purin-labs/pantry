import type { Env } from "../env";
import { requirePublicOrigin } from "../public-origin";

/**
 * One Slack card for one device incident (Plan 85). A reconnect updates the
 * same card. The text holds only names that a person confirmed and closed fault
 * codes, as plain text, so that a device cannot write to the channel.
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
  const organisation = encodeURIComponent(address.organisationHandle);
  const workspace = encodeURIComponent(address.workspaceHandle);
  return `${requirePublicOrigin(env.SATYR_PUBLIC_ORIGIN)}/portal/${organisation}/${workspace}/devices`;
}
