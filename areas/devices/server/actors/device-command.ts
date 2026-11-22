import { machineTransition } from "@purin-labs/std/state-machine";

import { DEVICE_COMMAND_MACHINE } from "./device-command.machine";
import { writeActorTransition } from "@purin-labs/actor-runtime/actors/lifecycle/state-transition";

/**
 * The pauses and resumes that a DeviceFleetActor sends to its gateways
 * (Refactor 15, refactor 6). This module is the one writer of
 * `device_command`. Each move goes through `DEVICE_COMMAND_MACHINE`.
 */

export type DeviceCommandKind = "pause" | "resume";
type DeviceCommandState = keyof typeof DEVICE_COMMAND_MACHINE.states;

type DeviceCommandRow = Readonly<{
  command_id: string;
  gateway_id: string;
  device_id: string;
  source_key: string;
  kind: DeviceCommandKind;
  state: DeviceCommandState;
}>;

/** A settled command stays this long, so a late answer still finds it. */
const SETTLED_RETENTION_MS = 7 * 24 * 60 * 60_000;
const COLUMNS = "command_id, gateway_id, device_id, source_key, kind, state";

export function deviceCommandSchemaStatements(): readonly string[] {
  return [
    `CREATE TABLE device_command (
       command_id TEXT PRIMARY KEY CHECK (length(command_id) > 0),
       gateway_id TEXT NOT NULL,
       device_id TEXT NOT NULL,
       source_key TEXT NOT NULL,
       kind TEXT NOT NULL CHECK (kind IN ('pause', 'resume')),
       state TEXT NOT NULL CHECK (
         state IN ('queued', 'sent', 'done', 'refused', 'superseded')
       ),
       created_at INTEGER NOT NULL,
       sent_at INTEGER,
       acked_at INTEGER
     )`,
    "CREATE INDEX device_command_by_device ON device_command (device_id, state)",
    "CREATE INDEX device_command_by_gateway ON device_command (gateway_id, state)",
  ];
}

/**
 * Stores a new command as queued. An open command of the same device ends as
 * superseded, because only the newest pause or resume holds.
 */
export function queueDeviceCommand(
  sql: SqlStorage,
  input: Readonly<{
    commandId: string;
    gatewayId: string;
    deviceId: string;
    sourceKey: string;
    kind: DeviceCommandKind;
    now: number;
  }>,
): DeviceCommandRow | null {
  const open = sql
    .exec<DeviceCommandRow>(
      `SELECT ${COLUMNS} FROM device_command
        WHERE device_id = ? AND state IN ('queued', 'sent')`,
      input.deviceId,
    )
    .toArray();
  for (const command of open) {
    const allowed = machineTransition(
      DEVICE_COMMAND_MACHINE,
      command.state,
      "supersede",
    );
    if (allowed.allowed) moveCommand(sql, command.command_id, allowed);
  }
  sql.exec(
    `INSERT INTO device_command (
       command_id, gateway_id, device_id, source_key, kind, state, created_at
     ) VALUES (?, ?, ?, ?, ?, 'queued', ?)
     ON CONFLICT (command_id) DO NOTHING`,
    input.commandId,
    input.gatewayId,
    input.deviceId,
    input.sourceKey,
    input.kind,
    input.now,
  );
  return (
    sql
      .exec<DeviceCommandRow>(
        `SELECT ${COLUMNS} FROM device_command WHERE command_id = ?`,
        input.commandId,
      )
      .toArray()[0] ?? null
  );
}

/** The commands of a gateway that still wait for its answer, oldest first. */
export function openDeviceCommands(
  sql: SqlStorage,
  gatewayId: string,
): readonly DeviceCommandRow[] {
  return sql
    .exec<DeviceCommandRow>(
      `SELECT ${COLUMNS} FROM device_command
        WHERE gateway_id = ? AND state IN ('queued', 'sent')
        ORDER BY created_at, command_id`,
      gatewayId,
    )
    .toArray();
}

/** Records that a socket carried the command. */
export function markDeviceCommandSent(
  sql: SqlStorage,
  command: DeviceCommandRow,
  now: number,
): void {
  const allowed = machineTransition(
    DEVICE_COMMAND_MACHINE,
    command.state,
    "send",
  );
  if (allowed.allowed && moveCommand(sql, command.command_id, allowed))
    sql.exec(
      "UPDATE device_command SET sent_at = ? WHERE command_id = ?",
      now,
      command.command_id,
    );
}

type DeviceCommandAnswer =
  | Readonly<{ kind: "unknown" }>
  | Readonly<{ kind: "ignored" }>
  | Readonly<{
      kind: "settled";
      command: DeviceCommandRow;
      to: "done" | "refused";
    }>;

/**
 * Applies a gateway's answer to the command that has its id. An answer from
 * another gateway, or to a command that is settled or superseded, moves
 * nothing. `unknown`: no command has this id, for example a snapshot.
 */
export function answerDeviceCommand(
  sql: SqlStorage,
  input: Readonly<{
    commandId: string;
    gatewayId: string;
    outcome: "done" | "refused";
    now: number;
  }>,
): DeviceCommandAnswer {
  const command = sql
    .exec<DeviceCommandRow>(
      `SELECT ${COLUMNS} FROM device_command WHERE command_id = ?`,
      input.commandId,
    )
    .toArray()[0];
  if (command === undefined) return { kind: "unknown" };
  const allowed = machineTransition(
    DEVICE_COMMAND_MACHINE,
    command.state,
    input.outcome === "done" ? "complete" : "refuse",
    { from_command_gateway: () => command.gateway_id === input.gatewayId },
  );
  if (!allowed.allowed || !moveCommand(sql, command.command_id, allowed))
    return { kind: "ignored" };
  sql.exec(
    "UPDATE device_command SET acked_at = ? WHERE command_id = ?",
    input.now,
    command.command_id,
  );
  return { kind: "settled", command, to: allowed.to };
}

export function deleteGatewayCommands(
  sql: SqlStorage,
  gatewayId: string,
): void {
  sql.exec("DELETE FROM device_command WHERE gateway_id = ?", gatewayId);
}

export function pruneSettledDeviceCommands(sql: SqlStorage, now: number): void {
  sql.exec(
    `DELETE FROM device_command
      WHERE state IN ('done', 'refused', 'superseded') AND created_at < ?`,
    now - SETTLED_RETENTION_MS,
  );
}

function moveCommand(
  sql: SqlStorage,
  commandId: string,
  allowed: Readonly<{ from: DeviceCommandState; to: DeviceCommandState }>,
): boolean {
  return writeActorTransition(sql, DEVICE_COMMAND_MACHINE.store, {
    key: commandId,
    from: allowed.from,
    value: allowed.to,
  });
}
