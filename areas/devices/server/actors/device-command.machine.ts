import type { MachineDefinition } from "@purin-labs/std/state-machine";

/**
 * One pause or resume that Pantry sends to a shop gateway for one device
 * (Plan 85; Refactor 15, refactor 6). The gateway answers with the command's
 * id. Only the gateway's `done` answer to the device's current pause confirms
 * the pause. A command that no socket carried, or that the gateway did not
 * answer, goes again when the gateway says hello. The Devices page shows a
 * pause that the gateway has not confirmed, and the person can resume it.
 */
export const DEVICE_COMMAND_MACHINE = {
  name: "device_command",
  owner: "areas/devices/server/actors/device-command.ts",
  store: {
    table: "device_command",
    key: "command_id",
    column: "state",
    since: "COALESCE(sent_at, created_at)",
  },
  states: {
    queued: {
      kind: "initial",
      meaning:
        "Pantry stored the command. The gateway had no open socket, so it gets the command at its next hello.",
      exit: { kind: "person", surface: "devices_page" },
    },
    sent: {
      kind: "intermediate",
      meaning:
        "The command went on the gateway's socket. Pantry waits for its answer, and sends it again at the next hello.",
      exit: { kind: "person", surface: "devices_page" },
    },
    done: {
      kind: "terminal",
      meaning: "The gateway did the command. A done pause is confirmed.",
    },
    refused: {
      kind: "terminal",
      meaning:
        "The gateway refused the command. A refused pause stays unconfirmed.",
    },
    superseded: {
      kind: "terminal",
      meaning:
        "A newer pause or resume of the same device replaced the command before the gateway answered.",
    },
  },
  transitions: [
    {
      event: "send",
      from: ["queued", "sent"],
      to: "sent",
      by: ["person", "agent", "gateway_hello"],
      guards: [],
    },
    {
      event: "complete",
      from: ["sent"],
      to: "done",
      by: ["gateway"],
      guards: ["from_command_gateway"],
    },
    {
      event: "refuse",
      from: ["sent"],
      to: "refused",
      by: ["gateway"],
      guards: ["from_command_gateway"],
    },
    {
      event: "supersede",
      from: ["queued", "sent"],
      to: "superseded",
      by: ["person", "agent"],
      guards: [],
    },
  ],
} as const satisfies MachineDefinition;
