import {
  beginProposalStaging,
  type StageConfigurationDraft,
} from "../../actors/session/proposal-staging";
import type { ToolTurnContext } from "../../actors/session/tool-wiring";
import { roleMayOperate } from "@purin-labs/tenancy/data/control-plane";
import { readDevice } from "../../devices/store";
import { withToolContext, type SessionToolContext } from "../context";
import { ToolRequestError } from "../errors";
import { liveDeviceMember } from "../session-support";
import {
  pauseDeviceForEmbeddedHarness,
  readDeviceSnapshotsForEmbeddedHarness,
  readDevicesForEmbeddedHarness,
} from "./handlers";
import type { DeviceProposeRequest, DeviceToolServices } from "./services";

/** What Devices gives to one turn: the services of the device tools. */
export function deviceToolServices(
  turn: ToolTurnContext,
  stageConfigurationDraft: StageConfigurationDraft,
): DeviceToolServices {
  const tool = withToolContext(turn);
  return {
    readDevices: tool(readDevicesForEmbeddedHarness),
    pauseDevice: tool(pauseDeviceForEmbeddedHarness),
    proposeDevice: proposeDeviceForEmbeddedHarness.bind(
      null,
      turn,
      stageConfigurationDraft,
    ),
    readDeviceSnapshots: tool(readDeviceSnapshotsForEmbeddedHarness),
  };
}

/**
 * Stages a restriction or a resume of one device, for the person who asked
 * to confirm on a card. Only a person changes a device's access.
 */
async function proposeDeviceForEmbeddedHarness(
  context: SessionToolContext,
  stageConfigurationDraft: StageConfigurationDraft,
  request: DeviceProposeRequest,
): Promise<unknown> {
  const member = await liveDeviceMember(
    context.execution.scope.database,
    context.execution.scope.organisationId,
    context.lease,
  );
  if (member === null || !roleMayOperate(member.role))
    throw new ToolRequestError(
      "A change to a device needs a person with the staff role or higher, and the person who asked does not have it now. Nothing changed. Tell the person.",
    );
  const device = await readDevice(
    context.execution.scope.database,
    context.execution.scope.organisationId,
    request.deviceId,
  );
  if (device === null)
    throw new ToolRequestError(
      "That device does not exist. Nothing changed. Call device_read for the list.",
    );
  const staging = await beginProposalStaging(context, "device proposal", {
    portalChat: true,
  });
  return stageConfigurationDraft(
    staging,
    {
      family: "device_command",
      command:
        request.action === "restrict"
          ? {
              kind: "device_restrict",
              deviceId: device.deviceId,
              deviceName: device.name,
              reason: request.reason,
            }
          : {
              kind: "device_resume",
              deviceId: device.deviceId,
              deviceName: device.name,
            },
    },
    {},
  );
}
