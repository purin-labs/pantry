import { DurableObject } from "cloudflare:workers";
import {
  DEVICE_CONNECTION_OFFLINE_MS,
  DEVICE_CONNECTION_QUIET_MS,
  DEVICE_GATEWAY_MESSAGE_BYTES,
  parseGatewayMessage,
  type DeviceAlertSetting,
  type DeviceConnection,
  type DeviceSampleReport,
  type GatewayMessage,
  type PlatformGatewayMessage,
} from "@purin-labs/control-api";

import {
  deliverDeviceAlerts,
  isWithinShopHours,
  offlineDelayMs,
  syncDeviceFaultAlert,
  syncGatewayAlerts,
} from "../devices/alerts";
import { gatewayConnection, type GatewayPresence } from "../devices/readiness";
import {
  pruneDeviceSnapshots,
  requestFaultSnapshots,
} from "../devices/snapshots";
import {
  applyGatewayHello,
  applyHealthReports,
  listGatewayDevices,
  pruneDeviceEvents,
  readDeviceAlertSetting,
  readGateway,
  recordDeviceEvent,
  recordGatewayHeard,
} from "../devices/store";
import type { Env } from "../env";
import { parseOrganisationId, type OrganisationId } from "../ids";
import { OrganisationExecutionScope } from "../organisation-execution-scope";
import {
  answerDeviceCommand,
  deleteGatewayCommands,
  markDeviceCommandSent,
  openDeviceCommands,
  pruneSettledDeviceCommands,
  queueDeviceCommand,
  type DeviceCommandKind,
} from "./device-command";
import { runDeviceFleetSchemaMigrations } from "./device-fleet-schema";
import {
  clearTerminalResultUnknown,
  deleteGatewayTerminalCollections,
  markGatewayCollectionsUnknown,
  openUnknownTerminalCollections,
  readTerminalCollection,
  recordTerminalResult,
  reserveTerminalCollection,
  type StartTerminalCollectionInput,
  type StartTerminalCollectionResult,
  type TerminalCollectionRecord,
} from "./device-fleet-terminal";
import { acceptSocket, closeSocket, openSockets } from "./hibernatable-sockets";
import { eraseUnregisteredActorState } from "./unregistered-actor-erasure";

/**
 * The connections of one shop location's gateways (Plan 85 D3). A gateway holds
 * one outbound socket here, so that telemetry does not load the Organisation
 * Actor. A heartbeat touches only the socket's attachment. The Actor writes D1
 * only when a fact changes, and a summary of the last heard time every five
 * minutes. Samples stay here for seven days.
 */

/** The socket close code that tells a gateway that its access has ended. */
const GATEWAY_REVOKED_CODE = 4403;
const GATEWAY_REPLACED_CODE = 4001;
const GATEWAY_INVALID_CODE = 1008;

const SUMMARY_INTERVAL_MS = 5 * 60_000;
const SAMPLE_RETENTION_MS = 7 * 24 * 60 * 60_000;
const SAMPLE_BUCKET_MS = 60_000;
const DELIVERY_RETRY_MS = 60_000;
const OUTSIDE_HOURS_CHECK_MS = 5 * 60_000;
const DAILY_MS = 24 * 60 * 60_000;

type GatewaySocketAttachment = Readonly<{
  gatewayId: string;
  lastHeardAt: number;
  summaryAt: number;
}>;

type FleetScopeRow = Readonly<{ organisation_id: string }>;

export type DeviceSample = Readonly<{
  name: string;
  value: number;
  unit: string;
  at: number;
}>;

export class DeviceFleetActor extends DurableObject<Env> {
  readonly #sql: SqlStorage;
  /** An erased Actor has no tables, so a late socket event does nothing. */
  #erased = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    runDeviceFleetSchemaMigrations(ctx.storage);
  }

  /** The Worker verified the gateway's credential before this call. */
  override async fetch(request: Request): Promise<Response> {
    const gatewayId = request.headers.get("x-satyr-device-gateway");
    const organisationId = request.headers.get("x-satyr-device-organisation");
    const locationId = request.headers.get("x-satyr-device-location");
    if (gatewayId === null || organisationId === null || locationId === null)
      return new Response(null, { status: 400 });
    this.#sql.exec(
      `INSERT INTO device_fleet_scope (singleton, organisation_id, location_id)
       VALUES (1, ?, ?) ON CONFLICT (singleton) DO NOTHING`,
      organisationId,
      locationId,
    );
    const now = Date.now();
    // One gateway holds one socket. Its newest connection is the true one.
    for (const socket of this.#gatewaySockets(gatewayId))
      closeSocket(socket, GATEWAY_REPLACED_CODE, "gateway_replaced");
    const attachment: GatewaySocketAttachment = {
      gatewayId,
      lastHeardAt: now,
      summaryAt: 0,
    };
    const accepted = acceptSocket(this.ctx, gatewayTag(gatewayId), attachment);
    if (accepted === null) return new Response(null, { status: 503 });
    this.#remember(gatewayId, now);
    await this.#armAlarm(now);
    return accepted;
  }

  override async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const attachment = readAttachment(socket);
    if (attachment === null) {
      closeSocket(socket, GATEWAY_INVALID_CODE, "unknown_socket");
      return;
    }
    if (
      typeof message !== "string" ||
      new TextEncoder().encode(message).byteLength >
        DEVICE_GATEWAY_MESSAGE_BYTES
    ) {
      closeSocket(socket, GATEWAY_INVALID_CODE, "invalid_message");
      return;
    }
    let raw: unknown = null;
    try {
      raw = JSON.parse(message);
    } catch {
      // The parser below refuses it.
    }
    const parsed = parseGatewayMessage(raw);
    if (parsed === null) {
      closeSocket(socket, GATEWAY_INVALID_CODE, "invalid_message");
      return;
    }
    const now = Date.now();
    const scope = await this.#scope();
    if (scope === null) {
      closeSocket(socket, 1011, "scope_unavailable");
      return;
    }
    const summaryDue = now - attachment.summaryAt >= SUMMARY_INTERVAL_MS;
    socket.serializeAttachment({
      ...attachment,
      lastHeardAt: now,
      summaryAt: summaryDue ? now : attachment.summaryAt,
    } satisfies GatewaySocketAttachment);
    if (summaryDue) {
      const active = await recordGatewayHeard(scope.database, {
        organisationId: scope.organisationId,
        gatewayId: attachment.gatewayId,
        now,
      });
      if (!active) {
        closeSocket(socket, GATEWAY_REVOKED_CODE, "gateway_revoked");
        return;
      }
    }
    await this.#apply(scope, socket, attachment.gatewayId, parsed, now);
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    await this.#socketEnded(socket);
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    await this.#socketEnded(socket);
  }

  override async alarm(): Promise<void> {
    const scope = await this.#scope();
    if (scope === null) return;
    const now = Date.now();
    for (const presence of this.presence()) {
      await this.#announce(scope, presence, now);
      const connection = gatewayConnection(presence, now);
      if (connection.state === "offline")
        for (const socket of this.#gatewaySockets(presence.gatewayId))
          closeSocket(socket, 1001, "gateway_silent");
    }
    const undelivered = await deliverDeviceAlerts(this.env, scope, now);
    this.#pruneOncePerDay(scope, now);
    await this.#armAlarm(now, scope, undelivered);
  }

  /** Who is connected, for the Devices list and for dispatch. */
  presence(): readonly GatewayPresence[] {
    const open = new Map<string, number>();
    for (const socket of openSockets(this.ctx)) {
      const attachment = readAttachment(socket);
      if (attachment !== null)
        open.set(
          attachment.gatewayId,
          Math.max(attachment.lastHeardAt, open.get(attachment.gatewayId) ?? 0),
        );
    }
    const rows = this.#sql
      .exec<{ gateway_id: string; last_heard_at: number | null }>(
        "SELECT gateway_id, last_heard_at FROM gateway_presence",
      )
      .toArray();
    return rows.map((row) => {
      const live = open.get(row.gateway_id);
      return {
        gatewayId: row.gateway_id,
        lastHeardAt: live ?? row.last_heard_at,
        socketOpen: live !== undefined,
      };
    });
  }

  /** Sends one message to a gateway. False when it has no open socket. */
  sendToGateway(gatewayId: string, message: PlatformGatewayMessage): boolean {
    const [socket] = this.#gatewaySockets(gatewayId);
    if (socket === undefined) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Stores one pause or resume of a device, then sends it. A gateway with no
   * open socket gets it at its next hello. False when no socket carried it now.
   */
  sendDeviceCommand(
    input: Readonly<{
      gatewayId: string;
      deviceId: string;
      message: Extract<
        PlatformGatewayMessage,
        Readonly<{ type: DeviceCommandKind }>
      >;
    }>,
  ): boolean {
    const now = Date.now();
    const { gatewayId, deviceId, message } = input;
    const command = queueDeviceCommand(this.#sql, {
      commandId: message.requestId,
      gatewayId,
      deviceId,
      sourceKey: message.sourceKey,
      kind: message.type,
      now,
    });
    if (command === null || !this.sendToGateway(gatewayId, message))
      return false;
    markDeviceCommandSent(this.#sql, command, now);
    return true;
  }

  /** Ends a revoked gateway's connection now. */
  closeGateway(gatewayId: string): void {
    for (const socket of this.#gatewaySockets(gatewayId))
      closeSocket(socket, GATEWAY_REVOKED_CODE, "gateway_revoked");
    this.#sql.exec("DELETE FROM device_sample WHERE gateway_id = ?", gatewayId);
    deleteGatewayCommands(this.#sql, gatewayId);
    deleteGatewayTerminalCollections(this.#sql, gatewayId);
  }

  /** Reserves exclusive collection ownership on one LAN payment terminal and dispatches `terminal_collect`. */
  startTerminalCollection(
    input: StartTerminalCollectionInput,
  ): StartTerminalCollectionResult {
    const sockets = this.#gatewaySockets(input.gatewayId);
    if (sockets.length === 0) {
      return {
        ok: false,
        reason: "gateway_offline",
        active: readTerminalCollection(
          this.#sql,
          input.gatewayId,
          input.sourceKey,
        ),
      };
    }
    const now = Date.now();
    const reserved = reserveTerminalCollection(this.#sql, input, now);
    if (!reserved.ok) return reserved;
    const sent = this.sendToGateway(input.gatewayId, {
      type: "terminal_collect",
      requestId: reserved.record.requestId,
      sourceKey: input.sourceKey,
      paymentAttemptId: input.paymentAttemptId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      paymentMethod: input.paymentMethod,
      expiresAt: input.expiresAt,
    });
    if (!sent) {
      markGatewayCollectionsUnknown(this.#sql, input.gatewayId, now);
      return {
        ok: false,
        reason: "gateway_offline",
        active: readTerminalCollection(
          this.#sql,
          input.gatewayId,
          input.sourceKey,
        ),
      };
    }
    return reserved;
  }

  cancelTerminalCollection(
    input: Readonly<{
      gatewayId: string;
      sourceKey: string;
      requestId: string;
      paymentAttemptId: string;
    }>,
  ): boolean {
    return this.sendToGateway(input.gatewayId, {
      type: "terminal_cancel",
      requestId: input.requestId,
      sourceKey: input.sourceKey,
      paymentAttemptId: input.paymentAttemptId,
    });
  }

  inquireTerminalCollection(
    input: Readonly<{
      gatewayId: string;
      sourceKey: string;
      requestId: string;
      paymentAttemptId: string;
    }>,
  ): boolean {
    return this.sendToGateway(input.gatewayId, {
      type: "terminal_inquire",
      requestId: input.requestId,
      sourceKey: input.sourceKey,
      paymentAttemptId: input.paymentAttemptId,
    });
  }

  readTerminalCollection(
    gatewayId: string,
    sourceKey: string,
  ): TerminalCollectionRecord | null {
    return readTerminalCollection(this.#sql, gatewayId, sourceKey);
  }

  clearTerminalResultUnknown(
    gatewayId: string,
    sourceKey: string,
    paymentAttemptId: string,
  ): boolean {
    return clearTerminalResultUnknown(
      this.#sql,
      gatewayId,
      sourceKey,
      paymentAttemptId,
      Date.now(),
    );
  }

  /** A task began or changed on one of this gateway's devices. */
  async refresh(): Promise<void> {
    await this.#armAlarm(Date.now());
  }

  /** The latest samples of one device, newest first. */
  samples(
    gatewayId: string,
    sourceKey: string,
    limit: number,
  ): readonly DeviceSample[] {
    return this.#sql
      .exec<{ name: string; bucket: number; value: number; unit: string }>(
        `SELECT name, bucket, value, unit FROM device_sample
          WHERE gateway_id = ? AND source_key = ?
          ORDER BY bucket DESC, name LIMIT ?`,
        gatewayId,
        sourceKey,
        limit,
      )
      .toArray()
      .map((row) => ({
        name: row.name,
        value: row.value,
        unit: row.unit,
        at: row.bucket * SAMPLE_BUCKET_MS,
      }));
  }

  async eraseUnregisteredState() {
    return eraseUnregisteredActorState(this.env, this.ctx.storage);
  }

  /** The Organisation ended, so this Actor holds nothing after this call. */
  async erase(): Promise<void> {
    for (const socket of this.ctx.getWebSockets())
      closeSocket(socket, GATEWAY_REVOKED_CODE, "organisation_ended");
    this.#erased = true;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async #apply(
    scope: OrganisationExecutionScope,
    socket: WebSocket,
    gatewayId: string,
    message: GatewayMessage,
    now: number,
  ): Promise<void> {
    const organisationId = scope.organisationId;
    switch (message.type) {
      case "heartbeat":
        return;
      case "hello": {
        await applyGatewayHello(scope.database, {
          organisationId,
          gatewayId,
          serviceVersion: message.serviceVersion,
          devices: message.devices,
          now,
        });
        this.#send(socket, { type: "welcome", gatewayId });
        this.#sendOpenCommands(socket, gatewayId, now);
        for (const unknown of openUnknownTerminalCollections(
          this.#sql,
          gatewayId,
        )) {
          this.#send(socket, {
            type: "terminal_inquire",
            requestId: `inquire_${unknown.requestId}`,
            sourceKey: unknown.sourceKey,
            paymentAttemptId: unknown.paymentAttemptId,
          });
        }
        await this.#applyHealth(scope, socket, gatewayId, message.health, now);
        this.#remember(gatewayId, now);
        await this.#announce(
          scope,
          { gatewayId, lastHeardAt: now, socketOpen: true },
          now,
        );
        await this.#armAlarm(now, scope);
        return;
      }
      case "health":
        await this.#applyHealth(scope, socket, gatewayId, message.reports, now);
        return;
      case "samples":
        await this.#applySamples(
          scope,
          socket,
          gatewayId,
          message.samples,
          now,
        );
        return;
      case "ack":
        await this.#applyAck(scope, gatewayId, message, now);
        return;
      case "terminal_result":
        recordTerminalResult(this.#sql, gatewayId, message, now);
        return;
    }
  }

  async #applyHealth(
    scope: OrganisationExecutionScope,
    socket: WebSocket,
    gatewayId: string,
    reports: Extract<GatewayMessage, { type: "health" }>["reports"],
    now: number,
  ): Promise<void> {
    if (reports.length === 0) return;
    const { changes, refused } = await applyHealthReports(scope.database, {
      organisationId: scope.organisationId,
      gatewayId,
      reports,
      now,
    });
    for (const sourceKey of refused)
      this.#send(socket, {
        type: "refused",
        reason: "unknown_device",
        sourceKey,
      });
    for (const change of changes) {
      await syncDeviceFaultAlert(this.env, scope, change.device, now);
      if (change.device.health === "fault" && change.previous !== "fault")
        await requestFaultSnapshots(scope, {
          device: change.device,
          locationId: this.#locationId(),
          now,
          send: (id, message) => this.sendToGateway(id, message),
        });
    }
  }

  async #applySamples(
    scope: OrganisationExecutionScope,
    socket: WebSocket,
    gatewayId: string,
    samples: readonly DeviceSampleReport[],
    now: number,
  ): Promise<void> {
    const known = new Set(
      (
        await listGatewayDevices(
          scope.database,
          scope.organisationId,
          gatewayId,
        )
      ).map((device) => device.sourceKey),
    );
    const bucket = Math.floor(now / SAMPLE_BUCKET_MS);
    for (const sample of samples) {
      if (!known.has(sample.sourceKey)) {
        this.#send(socket, {
          type: "refused",
          reason: "unknown_device",
          sourceKey: sample.sourceKey,
        });
        continue;
      }
      // One sample a minute for each measure. A faster report replaces it.
      this.#sql.exec(
        `INSERT OR REPLACE INTO device_sample (
           source_key, gateway_id, name, bucket, value, unit
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        sample.sourceKey,
        gatewayId,
        sample.name,
        bucket,
        sample.value,
        sample.unit,
      );
    }
  }

  /**
   * An answer settles only the command that has its id. Only a `done` answer
   * to a device's current pause confirms that pause.
   */
  async #applyAck(
    scope: OrganisationExecutionScope,
    gatewayId: string,
    message: Extract<GatewayMessage, { type: "ack" }>,
    now: number,
  ): Promise<void> {
    const separator = message.requestId.indexOf(":");
    if (separator < 0) return;
    let deviceId = message.requestId.slice(separator + 1);
    const answer = answerDeviceCommand(this.#sql, {
      commandId: message.requestId,
      gatewayId,
      outcome: message.outcome,
      now,
    });
    if (answer.kind === "ignored") return;
    if (answer.kind === "settled") {
      deviceId = answer.command.device_id;
      if (answer.command.kind === "pause" && answer.to === "done")
        await scope.database
          .prepare(
            `UPDATE device_enrollment SET pause_acknowledged_at = ?
              WHERE device_id = ? AND organisation_id = ?
                AND paused_at IS NOT NULL`,
          )
          .bind(now, deviceId, scope.organisationId)
          .run();
    } else {
      // A snapshot's answer has no command. It only goes on the record.
      const devices = await listGatewayDevices(
        scope.database,
        scope.organisationId,
        gatewayId,
      );
      if (!devices.some((device) => device.deviceId === deviceId)) return;
    }
    await recordDeviceEvent(scope.database, {
      organisationId: scope.organisationId,
      subjectId: deviceId,
      kind: `gateway_${message.outcome}`,
      actor: { kind: "gateway", id: gatewayId },
      detail: { request: message.requestId.slice(0, separator) },
      idempotencyKey: null,
      now,
    });
  }

  /** A command that no socket carried, or that has no answer, goes again. */
  #sendOpenCommands(socket: WebSocket, gatewayId: string, now: number): void {
    for (const command of openDeviceCommands(this.#sql, gatewayId))
      if (
        this.#send(socket, {
          type: command.kind,
          requestId: command.command_id,
          sourceKey: command.source_key,
        })
      )
        markDeviceCommandSent(this.#sql, command, now);
  }

  async #socketEnded(socket: WebSocket): Promise<void> {
    if (this.#erased) return;
    const attachment = readAttachment(socket);
    if (attachment === null) return;
    closeSocket(socket, 1000, "closed");
    const now = Date.now();
    this.#remember(attachment.gatewayId, attachment.lastHeardAt);
    const scope = await this.#scope();
    if (scope === null) return;
    const replaced = this.#gatewaySockets(attachment.gatewayId).length > 0;
    if (!replaced) {
      markGatewayCollectionsUnknown(this.#sql, attachment.gatewayId, now);
      await this.#announce(
        scope,
        {
          gatewayId: attachment.gatewayId,
          lastHeardAt: attachment.lastHeardAt,
          socketOpen: false,
        },
        now,
      );
    }
    await this.#armAlarm(now, scope);
  }

  /**
   * Records a change of connection, and opens or closes the gateway's alerts.
   * The alert check runs each time, because a task can begin while the
   * connection is already lost, and the offline delay can end.
   */
  async #announce(
    scope: OrganisationExecutionScope,
    presence: GatewayPresence,
    now: number,
  ): Promise<void> {
    const gateway = await readGateway(
      scope.database,
      scope.organisationId,
      presence.gatewayId,
    );
    if (gateway === null || gateway.state !== "active") return;
    const connection = gatewayConnection(presence, now);
    const row = this.#sql
      .exec<{ announced_state: string }>(
        "SELECT announced_state FROM gateway_presence WHERE gateway_id = ?",
        presence.gatewayId,
      )
      .toArray()[0];
    if (row?.announced_state !== connection.state) {
      this.#sql.exec(
        `INSERT INTO gateway_presence (gateway_id, last_heard_at, announced_state)
         VALUES (?, ?, ?)
         ON CONFLICT (gateway_id) DO UPDATE SET
           last_heard_at = excluded.last_heard_at,
           announced_state = excluded.announced_state`,
        presence.gatewayId,
        presence.lastHeardAt,
        connection.state,
      );
      await recordDeviceEvent(scope.database, {
        organisationId: scope.organisationId,
        subjectId: presence.gatewayId,
        kind: `connection_${connection.state}`,
        actor: { kind: "platform", id: null },
        detail: {},
        idempotencyKey: null,
        now,
      });
    }
    await syncGatewayAlerts(this.env, scope, gateway, connection, now);
  }

  #remember(gatewayId: string, lastHeardAt: number): void {
    this.#sql.exec(
      `INSERT INTO gateway_presence (gateway_id, last_heard_at, announced_state)
       VALUES (?, ?, 'never_connected')
       ON CONFLICT (gateway_id) DO UPDATE SET
         last_heard_at = excluded.last_heard_at`,
      gatewayId,
      lastHeardAt,
    );
  }

  #pruneOncePerDay(scope: OrganisationExecutionScope, now: number): void {
    const row = this.#sql
      .exec<{ pruned_at: number }>(
        "SELECT pruned_at FROM fleet_upkeep WHERE singleton = 1",
      )
      .toArray()[0];
    if (row !== undefined && now - row.pruned_at < DAILY_MS) return;
    this.#sql.exec(
      "DELETE FROM device_sample WHERE bucket < ?",
      Math.floor((now - SAMPLE_RETENTION_MS) / SAMPLE_BUCKET_MS),
    );
    pruneSettledDeviceCommands(this.#sql, now);
    this.#sql.exec(
      `INSERT INTO fleet_upkeep (singleton, pruned_at) VALUES (1, ?)
       ON CONFLICT (singleton) DO UPDATE SET pruned_at = excluded.pruned_at`,
      now,
    );
    this.ctx.waitUntil(
      pruneDeviceEvents(scope.database, scope.organisationId, now),
    );
    this.ctx.waitUntil(
      pruneDeviceSnapshots(this.env, scope.database, scope.organisationId, now),
    );
  }

  /** The next moment at which a connection can change state. */
  async #armAlarm(
    now: number,
    known?: OrganisationExecutionScope,
    undelivered = false,
  ): Promise<void> {
    const scope = known ?? (await this.#scope());
    let setting: DeviceAlertSetting | null = null;
    if (scope !== null)
      try {
        setting = await readDeviceAlertSetting(
          scope.database,
          scope.organisationId,
        );
      } catch {
        // The default delay still leads to a later check.
      }
    let due: number | null = undelivered ? now + DELIVERY_RETRY_MS : null;
    for (const presence of this.presence()) {
      const next = nextCheck(presence, now, setting);
      if (next !== null && (due === null || next < due)) due = next;
    }
    // The daily upkeep runs also for a silent gateway, so images reach their end.
    if (this.presence().length > 0 && (due === null || due > now + DAILY_MS))
      due = now + DAILY_MS;
    if (due === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(due, now + 1_000));
  }

  #send(socket: WebSocket, message: PlatformGatewayMessage): boolean {
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      // The gateway left. Its next connection starts with a new hello.
      return false;
    }
  }

  #locationId(): string {
    return (
      this.#sql
        .exec<{ location_id: string }>(
          "SELECT location_id FROM device_fleet_scope WHERE singleton = 1",
        )
        .toArray()[0]?.location_id ?? ""
    );
  }

  #gatewaySockets(gatewayId: string): WebSocket[] {
    return openSockets(this.ctx, gatewayTag(gatewayId));
  }

  async #scope(): Promise<OrganisationExecutionScope | null> {
    const row = this.#sql
      .exec<FleetScopeRow>(
        "SELECT organisation_id FROM device_fleet_scope WHERE singleton = 1",
      )
      .toArray()[0];
    if (row === undefined) return null;
    const organisationId = parseOrganisationId(row.organisation_id);
    if (!organisationId.ok) return null;
    const scope = await OrganisationExecutionScope.resolve(
      this.env,
      organisationId.value as OrganisationId,
    );
    return scope.ok ? scope.value : null;
  }
}

function nextCheck(
  presence: GatewayPresence,
  now: number,
  setting: DeviceAlertSetting | null,
): number | null {
  const connection: DeviceConnection = gatewayConnection(presence, now);
  switch (connection.state) {
    case "connected":
      return connection.lastHeardAt + DEVICE_CONNECTION_QUIET_MS + 1;
    case "quiet":
      return connection.lastHeardAt + DEVICE_CONNECTION_OFFLINE_MS + 1;
    case "offline": {
      const delayEnds = connection.lastHeardAt + offlineDelayMs(setting);
      if (delayEnds > now) return delayEnds;
      // Past the delay, the alert waits for shop hours. Inside them it opened.
      return isWithinShopHours(setting, now)
        ? null
        : now + OUTSIDE_HOURS_CHECK_MS;
    }
    default:
      return null;
  }
}

function gatewayTag(gatewayId: string): string {
  return `gateway:${gatewayId}`;
}

function readAttachment(socket: WebSocket): GatewaySocketAttachment | null {
  const raw: unknown = socket.deserializeAttachment();
  if (
    typeof raw === "object" &&
    raw !== null &&
    "gatewayId" in raw &&
    "lastHeardAt" in raw
  )
    return raw as GatewaySocketAttachment;
  return null;
}

/** The Actor of one shop location, placed where the Organisation is. */
export function deviceFleetStub(
  env: Env,
  scope: OrganisationExecutionScope,
  locationId: string,
): DurableObjectStub<DeviceFleetActor> | null {
  return env.DEVICE_FLEET === undefined
    ? null
    : deviceFleetStubAt(
        env.DEVICE_FLEET,
        scope.organisationId,
        scope.placement,
        locationId,
      );
}

export function deviceFleetStubAt(
  namespace: DurableObjectNamespace<DeviceFleetActor>,
  organisationId: OrganisationId,
  placement: OrganisationExecutionScope["placement"],
  locationId: string,
): DurableObjectStub<DeviceFleetActor> {
  const placed =
    placement.kind === "residency"
      ? namespace.jurisdiction(placement.residencyJurisdiction)
      : namespace;
  return placed.get(
    placed.idFromName(`device_fleet:${organisationId}:${locationId}`),
    { locationHint: placement.locationHint },
  );
}
