import type { runDeviceCommand } from "../commands";
import { definePort } from "@purin-labs/kernel/port";

/**
 * A command to a shop device, for a configuration draft that a person
 * confirms. The devices area owns the command, and the Worker registers the
 * implementation (`worker-ports.ts`).
 */
export type DeviceCommands = Readonly<{
  runDeviceCommand: typeof runDeviceCommand;
}>;

export const deviceCommands = definePort<DeviceCommands>("device_commands");
