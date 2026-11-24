import type { DeviceStationId } from "@purin-labs/control-api";
import type { Env } from "@purin-labs/kernel/env";
import { definePort } from "@purin-labs/kernel/port";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";

export type DeviceActorRef = Readonly<{
  kind: "person" | "agent" | "gateway" | "platform";
  id: string | null;
}>;

export type DeviceCommand =
  | Readonly<{ kind: "confirm"; name: string; stationId: DeviceStationId }>
  | Readonly<{ kind: "rename"; name: string }>
  | Readonly<{ kind: "move"; stationId: DeviceStationId }>
  | Readonly<{ kind: "restrict"; reason: string }>
  | Readonly<{ kind: "lift" }>
  | Readonly<{ kind: "pause" }>
  | Readonly<{ kind: "resume" }>
  | Readonly<{ kind: "settle" }>
  | Readonly<{ kind: "revoke" }>;

export type DeviceCommandResult =
  | Readonly<{ ok: true; receiptId: string; replayed: boolean }>
  | Readonly<{
      ok: false;
      code: "device_not_found" | "device_state_conflict";
    }>;

export type Run = Readonly<{
  env: Env;
  scope: OrganisationExecutionScope;
  actor: DeviceActorRef;
  idempotencyKey: string | null;
  now: number;
}>;

/** One command to a gateway or a device (`runDeviceCommand` of `commands.ts`). */
type RunDeviceCommand = (
  input: Run &
    Readonly<{
      subjectId: string;
      command: DeviceCommand;
    }>,
) => Promise<DeviceCommandResult>;

/**
 * A command to a shop device, for a configuration draft that a person
 * confirms. The devices area owns the command, and the Worker registers the
 * implementation (`worker-ports.ts`).
 */
export type DeviceCommands = Readonly<{
  runDeviceCommand: RunDeviceCommand;
}>;

export const deviceCommands = definePort<DeviceCommands>("device_commands");
