import { workspacePortalUrl } from "./portal-links";
import type { Env } from "../env";

/**
 * One Slack card for one device incident (Plan 85). A reconnect updates the
 * same card. The text holds only names that a person confirmed and closed fault
 * codes, as plain text, so that a device cannot write to the channel.
 */

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
