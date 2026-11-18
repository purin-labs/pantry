import type { DeviceStationId } from "@seams/control-api";

import { deviceFleetStub } from "../actors/device-fleet";
import type { ControlRole } from "../data/control-plane";
import type { Env } from "../env";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { closeResultUnknownAlert, openResultUnknownAlert } from "./alerts";
import {
  eventStatement,
  listGatewayDevices,
  readDevice,
  readEventByIdempotencyKey,
  readGateway,
  type DeviceActorRef,
  type DeviceRecord,
  type GatewayRecord,
} from "./store";

/**
 * What a person or an agent can do to a gateway or a device (Plan 85). The
 * Portal routes and the agent tools share these commands, so each one has the
 * same checks, record and receipt. An action that stops work is easy. An action
 * that starts work, widens access or changes a mapping needs more authority.
 */

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

export const DEVICE_COMMAND_ROLE: Readonly<
  Record<DeviceCommand["kind"], ControlRole>
> = {
  confirm: "admin",
  rename: "operator",
  move: "admin",
  restrict: "operator",
  lift: "admin",
  pause: "operator",
  resume: "operator",
  settle: "operator",
  revoke: "admin",
};

type DeviceCommandResult =
  | Readonly<{ ok: true; receiptId: string; replayed: boolean }>
  | Readonly<{
      ok: false;
      code: "device_not_found" | "device_state_conflict";
    }>;

type Run = Readonly<{
  env: Env;
  scope: OrganisationExecutionScope;
  actor: DeviceActorRef;
  idempotencyKey: string | null;
  now: number;
}>;

export async function runDeviceCommand(
  input: Run &
    Readonly<{
      subjectId: string;
      command: DeviceCommand;
    }>,
): Promise<DeviceCommandResult> {
  const { scope, subjectId, command } = input;
  if (input.idempotencyKey !== null) {
    const replay = await readEventByIdempotencyKey(
      scope.database,
      scope.organisationId,
      input.idempotencyKey,
    );
    if (replay !== null)
      return replay.subjectId === subjectId
        ? { ok: true, receiptId: replay.eventId, replayed: true }
        : { ok: false, code: "device_state_conflict" };
  }
  if (subjectId.startsWith("dgw_")) {
    const gateway = await readGateway(
      scope.database,
      scope.organisationId,
      subjectId,
    );
    return gateway === null
      ? { ok: false, code: "device_not_found" }
      : runGatewayCommand(input, gateway, command);
  }
  const device = await readDevice(
    scope.database,
    scope.organisationId,
    subjectId,
  );
  return device === null
    ? { ok: false, code: "device_not_found" }
    : runKitchenDeviceCommand(input, device, command);
}

async function runGatewayCommand(
  run: Run,
  gateway: GatewayRecord,
  command: DeviceCommand,
): Promise<DeviceCommandResult> {
  const { scope, now } = run;
  const db = scope.database;
  const organisationId = scope.organisationId;
  const receiptId = newReceiptId();
  switch (command.kind) {
    case "rename": {
      if (gateway.state === "revoked") return conflict();
      await db.batch([
        db
          .prepare(
            "UPDATE device_gateway SET name = ? WHERE gateway_id = ? AND organisation_id = ?",
          )
          .bind(command.name, gateway.gatewayId, organisationId),
        event(run, gateway.gatewayId, "renamed", receiptId, {
          name: command.name,
        }),
      ]);
      return done(receiptId);
    }
    case "revoke": {
      if (gateway.state === "revoked") return conflict();
      const devices = await listGatewayDevices(
        db,
        organisationId,
        gateway.gatewayId,
      );
      const inFlight = devices.filter(hasActiveTask);
      await db.batch([
        db
          .prepare(
            `UPDATE device_gateway
                SET state = 'revoked', credential_sha256 = NULL,
                    code_sha256 = NULL, code_expires_at = NULL, revoked_at = ?,
                    revoked_by = ?
              WHERE gateway_id = ? AND organisation_id = ?`,
          )
          .bind(now, run.actor.id, gateway.gatewayId, organisationId),
        db
          .prepare(
            `UPDATE device_enrollment
                SET state = 'revoked', revoked_at = ?, restrict_reason = NULL,
                    work_state = CASE WHEN work_state IN ('reserved', 'running')
                      THEN 'result_unknown' ELSE work_state END
              WHERE gateway_id = ? AND organisation_id = ?
                AND state != 'revoked'`,
          )
          .bind(now, gateway.gatewayId, organisationId),
        event(run, gateway.gatewayId, "revoked", receiptId, {}),
      ]);
      await closeGatewaySocket(run, gateway);
      for (const device of inFlight)
        await openResultUnknownAlert(run.env, scope, device, now);
      return done(receiptId);
    }
    default:
      return conflict();
  }
}

async function runKitchenDeviceCommand(
  run: Run,
  device: DeviceRecord,
  command: DeviceCommand,
): Promise<DeviceCommandResult> {
  const { scope, now } = run;
  const db = scope.database;
  const organisationId = scope.organisationId;
  const receiptId = newReceiptId();
  const update = (assignments: string, ...values: readonly unknown[]) =>
    db
      .prepare(
        `UPDATE device_enrollment SET ${assignments}
          WHERE device_id = ? AND organisation_id = ?`,
      )
      .bind(...values, device.deviceId, organisationId);
  if (device.enrollment === "revoked" && command.kind !== "settle")
    return conflict();
  switch (command.kind) {
    case "confirm": {
      if (device.enrollment !== "pending") return conflict();
      await db.batch([
        update(
          "state = 'active', verified_at = ?, name = ?, station_id = ?",
          now,
          command.name,
          command.stationId,
        ),
        event(run, device.deviceId, "confirmed", receiptId, {
          name: command.name,
          stationId: command.stationId,
        }),
      ]);
      return done(receiptId);
    }
    case "rename": {
      await db.batch([
        update("name = ?", command.name),
        event(run, device.deviceId, "renamed", receiptId, {
          name: command.name,
        }),
      ]);
      return done(receiptId);
    }
    case "move": {
      if (device.enrollment === "pending") return conflict();
      await db.batch([
        update("station_id = ?", command.stationId),
        event(run, device.deviceId, "moved", receiptId, {
          stationId: command.stationId,
        }),
      ]);
      return done(receiptId);
    }
    case "restrict": {
      if (device.enrollment !== "active") return conflict();
      await db.batch([
        update(
          "state = 'restricted', restrict_reason = ?, restricted_at = ?",
          command.reason,
          now,
        ),
        event(run, device.deviceId, "restricted", receiptId, {
          reason: command.reason,
        }),
      ]);
      return done(receiptId);
    }
    case "lift": {
      if (device.enrollment !== "restricted") return conflict();
      await db.batch([
        update(
          "state = 'active', restrict_reason = NULL, restricted_at = NULL",
        ),
        event(run, device.deviceId, "restriction_lifted", receiptId, {}),
      ]);
      return done(receiptId);
    }
    case "pause": {
      if (device.enrollment === "pending" || device.paused) return conflict();
      await db.batch([
        update("paused_at = ?, pause_acknowledged_at = NULL", now),
        event(run, device.deviceId, "pause_requested", receiptId, {}),
      ]);
      await tellGateway(run, device, {
        type: "pause",
        requestId: `${receiptId}:${device.deviceId}`,
        sourceKey: device.sourceKey,
      });
      return done(receiptId);
    }
    case "resume": {
      if (!device.paused) return conflict();
      await db.batch([
        update("paused_at = NULL, pause_acknowledged_at = NULL"),
        event(run, device.deviceId, "resumed", receiptId, {}),
      ]);
      await tellGateway(run, device, {
        type: "resume",
        requestId: `${receiptId}:${device.deviceId}`,
        sourceKey: device.sourceKey,
      });
      return done(receiptId);
    }
    case "settle": {
      if (device.work.state !== "result_unknown") return conflict();
      await db.batch([
        update(
          "work_state = 'idle', work_task_ref = NULL, work_run_ref = NULL, work_label = NULL, work_at = ?",
          now,
        ),
        event(run, device.deviceId, "result_checked", receiptId, {}),
      ]);
      await closeResultUnknownAlert(run.env, scope, device, now);
      return done(receiptId);
    }
    case "revoke": {
      const inFlight = hasActiveTask(device);
      await db.batch([
        update(
          `state = 'revoked', revoked_at = ?, restrict_reason = NULL,
           work_state = CASE WHEN work_state IN ('reserved', 'running')
             THEN 'result_unknown' ELSE work_state END`,
          now,
        ),
        event(run, device.deviceId, "revoked", receiptId, {}),
      ]);
      if (inFlight) await openResultUnknownAlert(run.env, scope, device, now);
      return done(receiptId);
    }
  }
}

function hasActiveTask(device: DeviceRecord): boolean {
  return device.work.state === "reserved" || device.work.state === "running";
}

function event(
  run: Run,
  subjectId: string,
  kind: string,
  receiptId: string,
  detail: Readonly<Record<string, unknown>>,
): D1PreparedStatement {
  return eventStatement(run.scope.database, {
    eventId: receiptId,
    organisationId: run.scope.organisationId,
    subjectId,
    kind,
    actor: run.actor,
    detail,
    idempotencyKey: run.idempotencyKey,
    now: run.now,
  });
}

function newReceiptId(): string {
  return `devt_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function done(receiptId: string): DeviceCommandResult {
  return { ok: true, receiptId, replayed: false };
}

function conflict(): DeviceCommandResult {
  return { ok: false, code: "device_state_conflict" };
}

async function closeGatewaySocket(
  run: Run,
  gateway: GatewayRecord,
): Promise<void> {
  const stub = deviceFleetStub(run.env, run.scope, gateway.locationId);
  // The credential is refused now. An open socket also ends at its next
  // summary, when the Actor reads the revocation.
  await stub?.closeGateway(gateway.gatewayId).catch(() => undefined);
}

async function tellGateway(
  run: Run,
  device: DeviceRecord,
  message: Readonly<{
    type: "pause" | "resume";
    requestId: string;
    sourceKey: string;
  }>,
): Promise<void> {
  const gateway = await readGateway(
    run.scope.database,
    run.scope.organisationId,
    device.gatewayId,
  );
  if (gateway === null) return;
  const stub = deviceFleetStub(run.env, run.scope, gateway.locationId);
  // Pantry already stopped its own dispatch. The Actor keeps the command until
  // the gateway answers it, so a gateway with no socket gets it at its hello.
  await stub
    ?.sendDeviceCommand({
      gatewayId: gateway.gatewayId,
      deviceId: device.deviceId,
      message,
    })
    .catch(() => false);
}
