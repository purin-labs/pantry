import { defineToolFamily } from "@purin-labs/agent-tools/define-tool";
import { ToolRequestError } from "@purin-labs/agent-tools/errors";
import type { PreparedEffect } from "@purin-labs/agent-tools/tool-effect";

type DeviceReadTool = () => Promise<DeviceToolRead>;

export type DeviceToolRead = Readonly<{
  gateways: readonly Readonly<Record<string, unknown>>[];
  devices: readonly Readonly<Record<string, unknown>>[];
  shopMacs: readonly Readonly<Record<string, unknown>>[];
}>;

type DeviceSnapshotReadTool = () => Promise<
  Readonly<{
    snapshotsEnabled: boolean;
    snapshots: readonly Readonly<Record<string, unknown>>[];
  }>
>;

export type DevicePauseRequest = Readonly<{ deviceId: string }>;

type DevicePauseTool = (
  request: DevicePauseRequest,
  operationId: string,
) => Promise<PreparedEffect>;

export type DeviceProposeRequest = Readonly<{
  deviceId: string;
  action: "restrict" | "resume";
  reason: string | null;
}>;

type DeviceProposeTool = (request: DeviceProposeRequest) => Promise<unknown>;

/** A device request that was refused, in words that the agent can act on. */
export class DeviceRequestError extends ToolRequestError {}

/** What a turn gives to the device tools. */
export type DeviceToolServices = {
  readonly readDevices: DeviceReadTool;
  readonly pauseDevice: DevicePauseTool;
  readonly proposeDevice: DeviceProposeTool;
  readonly readDeviceSnapshots: DeviceSnapshotReadTool;
};

export const defineDeviceTool =
  defineToolFamily<DeviceToolServices>()("devices");
