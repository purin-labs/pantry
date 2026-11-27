import { DurableObject } from "cloudflare:workers";
import {
  DEVICE_CONNECTION_OFFLINE_MS,
  DEVICE_CONNECTION_QUIET_MS,
  DEVICE_GATEWAY_MESSAGE_BYTES,
  parseGatewayMessage,
  type CobotClockEntry,
  type CobotReport,
  type CobotRunSignal,
  type CobotTaskMessage,
  type CounterPrinterJob,
  type CounterReceiptPrinter,
  type DeviceAlertSetting,
  type DeviceConnection,
  type DeviceSampleReport,
  type GatewayMessage,
  type PlatformGatewayMessage,
  type PrinterTask,
  type ReceiptLayout,
} from "@purin-labs/control-api";

import {
  deliverDeviceAlerts,
  isWithinShopHours,
  offlineDelayMs,
  syncDeviceFaultAlert,
  syncGatewayAlerts,
} from "../alerts";
import { gatewayConnection } from "../readiness";
import { pruneDeviceSnapshots, requestFaultSnapshots } from "../snapshots";
import {
  applyGatewayHello,
  applyHealthReports,
  listGatewayDevices,
  listGateways,
  pruneDeviceEvents,
  readDeviceAlertSetting,
  readGateway,
  recordDeviceEvent,
  recordGatewayHeard,
} from "../store";
import { changeDeviceWork, type DeviceWorkChange } from "../work";
import type { Env } from "@purin-labs/kernel/env";
import { traceWarn } from "@purin-labs/kernel/observability";
import {
  newRequestId,
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  answerDeviceCommand,
  deleteGatewayCommands,
  markDeviceCommandSent,
  openDeviceCommands,
  pruneSettledDeviceCommands,
  queueDeviceCommand,
} from "./device-command";
import {
  deleteGatewayPrinterJobs,
  insertPrinterJob,
  listCheckoutPrinterJobs,
  PRINTER_JOB_RESEND_MS,
  printerJobView,
  prunePrinterJobs,
  readPrinterJob,
  recordPrinterResult,
  reopenPrinterJobs,
  unsentPrinterJob,
} from "./device-fleet-printer";
import {
  deleteGatewayCobotRecords,
  insertCobotDispatch,
  knownCobotRuns,
  listRunDispatches,
  markGatewayDispatchesUnknown,
  pruneCobotDispatches,
  readCobotDispatch,
  recordCobotReport,
  setCobotDispatchState,
  unknownGatewayDispatches,
  unwatchCobotRun,
  watchCobotRun,
  watchingRuns,
} from "./device-fleet-cobot";
import { runDeviceFleetSchemaMigrations } from "./device-fleet-schema";
import {
  clearTerminalResultUnknown,
  deleteGatewayTerminalCollections,
  markGatewayCollectionsUnknown,
  openUnknownTerminalCollections,
  readTerminalCollection,
  recordTerminalResult,
  reserveTerminalCollection,
} from "./device-fleet-terminal";
import type {
  CobotDispatchApproval,
  CobotDispatchRecord,
  CobotDispatchState,
  CobotRunRpc,
  DeviceCommandKind,
  DeviceFleetRpc,
  DeviceSample,
  GatewayPresence,
  StartTerminalCollectionInput,
  StartTerminalCollectionResult,
  TerminalCollectionRecord,
} from "@purin-labs/area-devices-contract/server/fleet-stub";
import {
  acceptSocket,
  closeSocket,
  openSockets,
} from "@purin-labs/actor-runtime/actors/hibernatable-sockets";
import { eraseUnregisteredActorState } from "@purin-labs/actor-runtime/actors/unregistered-actor-erasure";

export type { DeviceSample } from "@purin-labs/area-devices-contract/server/fleet-stub";

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
/** A print waits this long for the gateway's answer, then shows `sent`. */
const PRINTER_ANSWER_MS = 8_000;
/** A clock read waits this long for the gateway's answer. */
const CLOCK_ANSWER_MS = 5_000;

/** The receipt printer that this location's counter uses. */
type BoundPrinter = Readonly<{
  view: CounterReceiptPrinter;
  gatewayId: string;
  sourceKey: string;
}>;

type GatewaySocketAttachment = Readonly<{
  gatewayId: string;
  lastHeardAt: number;
  summaryAt: number;
}>;

type FleetScopeRow = Readonly<{ organisation_id: string }>;

/**
 * @public `workers/platform/src/integration-gateway.ts` exports it for the
 * Durable Object binding DEVICE_FLEET of `wrangler.jsonc`.
 */
export class DeviceFleetActor
  extends DurableObject<Env>
  implements DeviceFleetRpc
{
  readonly #sql: SqlStorage;
  /** An erased Actor has no tables, so a late socket event does nothing. */
  #erased = false;
  /** The calls that wait for a printer's answer, by request. */
  readonly #printerWaiters = new Map<string, (() => void)[]>();
  /** The clock reads that wait for the gateway's answer, by request. */
  readonly #clockWaiters = new Map<
    string,
    (clocks: readonly CobotClockEntry[]) => void
  >();
  /** The signals on their way to each run, in the gateway's order. */
  readonly #forwards = new Map<string, Promise<void>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    runDeviceFleetSchemaMigrations(ctx.storage);
  }

  /** The Worker verified the gateway's credential before this call. */
  override async fetch(request: Request): Promise<Response> {
    const gatewayId = request.headers.get("x-pantry-device-gateway");
    const organisationId = request.headers.get("x-pantry-device-organisation");
    const locationId = request.headers.get("x-pantry-device-location");
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
    deleteGatewayPrinterJobs(this.#sql, gatewayId);
    deleteGatewayCobotRecords(this.#sql, gatewayId);
  }

  /**
   * Prints one receipt or opens the cash drawer on this location's bound
   * printer, then waits a short time for the gateway's answer. The same
   * `requestId` is one task: a second call reads it, and sends it again only
   * while it has no answer. A printer error ends the task and changes no sale.
   */
  async runPrinterTask(
    input: Readonly<{
      task: PrinterTask;
      requestId: string;
      checkoutId: string;
      receipt: ReceiptLayout | null;
    }>,
  ): Promise<CounterPrinterJob> {
    const existing = readPrinterJob(this.#sql, input.requestId);
    if (existing !== null) {
      // Only a young task goes again, as at a hello: nothing prints late.
      if (
        existing.state === "sent" &&
        Date.now() - existing.createdAt <= PRINTER_JOB_RESEND_MS &&
        this.#sendRaw(existing.gatewayId, existing.messageJson)
      )
        await this.#waitForPrinter(existing.requestId);
      const settled = readPrinterJob(this.#sql, input.requestId) ?? existing;
      return printerJobView(settled);
    }
    const printer = await this.#boundPrinter();
    if (printer === null)
      return unsentPrinterJob(input.requestId, input.task, "no_printer");
    if (input.task === "cash_drawer_kick" && !printer.view.drawer)
      return unsentPrinterJob(input.requestId, input.task, "no_drawer");
    if (!printer.view.connected)
      return unsentPrinterJob(input.requestId, input.task, "gateway_offline");
    let message: PlatformGatewayMessage;
    if (input.task === "receipt_print") {
      if (input.receipt === null)
        throw new Error("A receipt print needs a receipt layout");
      message = {
        type: "receipt_print",
        requestId: input.requestId,
        sourceKey: printer.sourceKey,
        receipt: input.receipt,
      };
    } else {
      message = {
        type: "cash_drawer_kick",
        requestId: input.requestId,
        sourceKey: printer.sourceKey,
      };
    }
    const messageJson = JSON.stringify(message);
    insertPrinterJob(
      this.#sql,
      {
        requestId: input.requestId,
        gatewayId: printer.gatewayId,
        sourceKey: printer.sourceKey,
        task: input.task,
        checkoutId: input.checkoutId,
        messageJson,
      },
      Date.now(),
    );
    // A send that fails leaves the task open; the next hello sends it again.
    if (this.#sendRaw(printer.gatewayId, messageJson))
      await this.#waitForPrinter(input.requestId);
    const job = readPrinterJob(this.#sql, input.requestId);
    if (job === null) throw new Error("A printer task did not persist");
    return printerJobView(job);
  }

  /** The bound printer of this location's counter, or null. */
  async counterPrinter(): Promise<CounterReceiptPrinter | null> {
    return (await this.#boundPrinter())?.view ?? null;
  }

  /** The print and drawer tasks of one sale, oldest first. */
  printerJobs(checkoutId: string): readonly CounterPrinterJob[] {
    return listCheckoutPrinterJobs(this.#sql, checkoutId).map(printerJobView);
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

  /**
   * Plan 24 S4: writes one cobot or oven task to the dispatch ledger, then
   * sends it. A second dispatch with the same identity returns the stored
   * state and sends nothing. A task that no socket carried stays `unsent`;
   * only a person's settle of its run asks for it again, with the same
   * identity, so the gateway's journal still makes it one move.
   *
   * S6: a new task goes only for a run that watches the device: an approved
   * run that is active. A call for a run that ended, or a forged one, is
   * refused, and nothing is written or sent.
   */
  async dispatchCobotTask(
    input: Readonly<{
      gatewayId: string;
      deviceId: string;
      runActorId: string;
      message: CobotTaskMessage;
      approval: CobotDispatchApproval;
    }>,
  ): Promise<
    Readonly<{ state: CobotDispatchState | "refused"; replayed: boolean }>
  > {
    const { message } = input;
    const now = Date.now();
    const known = readCobotDispatch(this.#sql, message.requestId);
    if (known !== null && known.state !== "unsent")
      return { state: known.state, replayed: true };
    if (
      !watchingRuns(this.#sql, input.gatewayId, [message.sourceKey]).includes(
        input.runActorId,
      )
    )
      return { state: "refused", replayed: false };
    if (known === null) {
      const scope = await this.#scope();
      if (scope === null) return { state: "unsent", replayed: false };
      insertCobotDispatch(this.#sql, input, now);
      await recordDeviceEvent(scope.database, {
        organisationId: scope.organisationId,
        subjectId: input.deviceId,
        kind: "cobot_task_sent",
        actor: { kind: "platform", id: null },
        detail: {
          requestId: message.requestId,
          runId: message.runId,
          taskId: message.taskId,
          task: message.task,
          approvedBy: input.approval.by,
          approvedRole: input.approval.role,
          approvedVia: input.approval.via,
          approvedAt: input.approval.at,
        },
        idempotencyKey: null,
        now,
      });
    }
    const sent = this.sendToGateway(input.gatewayId, message);
    const state: CobotDispatchState = sent ? "sent" : "unsent";
    setCobotDispatchState(this.#sql, message.requestId, state, now);
    return { state, replayed: false };
  }

  /** The dispatch ledger of one run, oldest first. */
  cobotDispatches(runActorId: string): readonly CobotDispatchRecord[] {
    return listRunDispatches(this.#sql, runActorId);
  }

  /**
   * The clock of each cobot and oven of a gateway now, from the gateway's
   * last line of each controller. Null when the gateway does not answer.
   */
  async readCobotClocks(
    gatewayId: string,
  ): Promise<readonly CobotClockEntry[] | null> {
    const requestId = `clk_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const answer = new Promise<readonly CobotClockEntry[] | null>((resolve) => {
      const timer = setTimeout(() => {
        this.#clockWaiters.delete(requestId);
        resolve(null);
      }, CLOCK_ANSWER_MS);
      this.#clockWaiters.set(requestId, (clocks) => {
        clearTimeout(timer);
        this.#clockWaiters.delete(requestId);
        resolve(clocks);
      });
    });
    if (!this.sendToGateway(gatewayId, { type: "cobot_clock_read", requestId }))
      this.#clockWaiters.get(requestId)?.([]);
    const clocks = await answer;
    return clocks === null || clocks.length === 0 ? null : clocks;
  }

  /** A run gets the signals of these devices while it is active. */
  watchCobotRun(
    runActorId: string,
    devices: readonly Readonly<{ gatewayId: string; sourceKey: string }>[],
  ): void {
    watchCobotRun(this.#sql, runActorId, devices);
  }

  unwatchCobotRun(runActorId: string): void {
    unwatchCobotRun(this.#sql, runActorId);
  }

  /** S6: a person revoked a device; each run that watches it holds. */
  deviceRevoked(gatewayId: string, sourceKey: string): void {
    const at = Date.now();
    for (const runActorId of watchingRuns(this.#sql, gatewayId, [sourceKey]))
      this.#forward(runActorId, { kind: "device_revoked", sourceKey, at });
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

  /**
   * The Organisation ended, so this Actor holds nothing after this call. It
   * also empties the Durable Object of each bake run that it served.
   */
  async erase(): Promise<void> {
    for (const socket of this.ctx.getWebSockets())
      closeSocket(socket, GATEWAY_REVOKED_CODE, "organisation_ended");
    const runs = this.#runs();
    if (runs !== undefined && !this.#erased)
      for (const runActorId of knownCobotRuns(this.#sql))
        await runs.get(runs.idFromString(runActorId)).erase();
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
        for (const job of reopenPrinterJobs(this.#sql, gatewayId, now))
          this.#sendRawTo(socket, job.messageJson);
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
        // A dispatch whose result became unknown is asked, never sent again.
        for (const dispatch of unknownGatewayDispatches(this.#sql, gatewayId))
          this.#send(socket, {
            type: "cobot_inquire",
            requestId: dispatch.requestId,
            sourceKey: dispatch.sourceKey,
          });
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
      case "printer_result":
        recordPrinterResult(this.#sql, gatewayId, message, now);
        this.#releasePrinterWaiters(message.requestId);
        return;
      // A cobot's task reports, clocks and shadow observations (Plan 24).
      case "cobot_report":
        await this.#applyCobotReport(scope, gatewayId, message, now);
        return;
      case "cobot_clock":
        if (message.requestId !== undefined) {
          this.#clockWaiters.get(message.requestId)?.(message.clocks);
          return;
        }
        for (const runActorId of watchingRuns(
          this.#sql,
          gatewayId,
          message.clocks.map((entry) => entry.sourceKey),
        ))
          this.#forward(runActorId, { kind: "clock", clock: message });
        return;
      case "cobot_observed":
        for (const runActorId of watchingRuns(this.#sql, gatewayId, [
          message.sourceKey,
        ]))
          this.#forward(runActorId, { kind: "observed", observed: message });
        return;
    }
  }

  /**
   * A report settles the dispatch that has its identity, moves the device's
   * Work fact on, and goes to the dispatch's run. A dispatch whose result
   * became unknown keeps that Work fact until a person settles it.
   */
  async #applyCobotReport(
    scope: OrganisationExecutionScope,
    gatewayId: string,
    report: CobotReport,
    now: number,
  ): Promise<void> {
    const before = recordCobotReport(this.#sql, gatewayId, report, now);
    if (before === null) return;
    if (before.state !== "result_unknown" && before.state !== report.state) {
      const to: DeviceWorkChange =
        report.state === "accepted" || report.state === "running"
          ? "running"
          : report.state === "indeterminate"
            ? "result_unknown"
            : "idle";
      await changeDeviceWork(this.env, scope, {
        deviceId: before.deviceId,
        taskRef: before.requestId,
        to,
        now,
      });
      if (to !== "running")
        await recordDeviceEvent(scope.database, {
          organisationId: scope.organisationId,
          subjectId: before.deviceId,
          kind: `cobot_task_${report.state}`,
          actor: { kind: "gateway", id: gatewayId },
          detail: {
            requestId: before.requestId,
            runId: before.runId,
            taskId: before.taskId,
            reason: report.reason,
          },
          idempotencyKey: null,
          now,
        });
    }
    this.#forward(before.runActorId, { kind: "report", report });
  }

  /** Each open dispatch of a lost gateway has an unknown result now. */
  async #cobotConnectionLost(
    scope: OrganisationExecutionScope,
    gatewayId: string,
    now: number,
  ): Promise<void> {
    const lost = markGatewayDispatchesUnknown(this.#sql, gatewayId, now);
    const byRun = new Map<string, string[]>();
    for (const dispatch of lost) {
      await changeDeviceWork(this.env, scope, {
        deviceId: dispatch.deviceId,
        taskRef: dispatch.requestId,
        to: "result_unknown",
        now,
      });
      byRun.set(dispatch.runActorId, [
        ...(byRun.get(dispatch.runActorId) ?? []),
        dispatch.requestId,
      ]);
    }
    for (const [runActorId, requestIds] of byRun)
      this.#forward(runActorId, {
        kind: "connection_lost",
        requestIds,
        at: now,
      });
  }

  /** The bake run Actors, by the methods that this Actor calls. */
  #runs(): DurableObjectNamespace<CobotRunRpc> | undefined {
    return this.env.BAKE_RUN;
  }

  /**
   * Gives one signal to a run's Durable Object, after the signals before it,
   * so that the run reads the gateway's order. The run is known only by the
   * id string that it gave with its dispatch or its watch.
   */
  #forward(runActorId: string, signal: CobotRunSignal): void {
    const namespace = this.#runs();
    if (namespace === undefined) return;
    const previous = this.#forwards.get(runActorId) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        await namespace
          .get(namespace.idFromString(runActorId))
          .receiveCobotSignal(signal);
      } catch (error) {
        traceWarn("devices.cobot_signal_undelivered", {
          requestId: newRequestId(),
          runActorId,
          kind: signal.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    this.#forwards.set(runActorId, next);
    this.ctx.waitUntil(
      next.then(() => {
        if (this.#forwards.get(runActorId) === next)
          this.#forwards.delete(runActorId);
      }),
    );
  }

  /**
   * The first active receipt printer on an active gateway of this location.
   * A person confirms a printer on the Devices page before it prints.
   */
  async #boundPrinter(): Promise<BoundPrinter | null> {
    const scope = await this.#scope();
    if (scope === null) return null;
    const locationId = this.#locationId();
    const gateways = (
      await listGateways(scope.database, scope.organisationId)
    ).filter(
      (gateway) =>
        gateway.state === "active" && gateway.locationId === locationId,
    );
    for (const gateway of gateways) {
      const printer = (
        await listGatewayDevices(
          scope.database,
          scope.organisationId,
          gateway.gatewayId,
        )
      ).find(
        (device) =>
          device.hardware === "receipt_printer" &&
          device.enrollment === "active",
      );
      if (printer === undefined) continue;
      return {
        gatewayId: gateway.gatewayId,
        sourceKey: printer.sourceKey,
        view: {
          deviceId: printer.deviceId,
          name: printer.name,
          drawer: printer.capabilities.some(
            (capability) => capability.id === "cash_drawer",
          ),
          connected: this.#gatewaySockets(gateway.gatewayId).length > 0,
        },
      };
    }
    return null;
  }

  #sendRaw(gatewayId: string, messageJson: string): boolean {
    const [socket] = this.#gatewaySockets(gatewayId);
    if (socket === undefined) return false;
    try {
      socket.send(messageJson);
      return true;
    } catch {
      return false;
    }
  }

  #waitForPrinter(requestId: string): Promise<void> {
    return new Promise((resolve) => {
      const waiters = this.#printerWaiters.get(requestId) ?? [];
      const timer = setTimeout(done, PRINTER_ANSWER_MS);
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
      waiters.push(done);
      this.#printerWaiters.set(requestId, waiters);
    });
  }

  #releasePrinterWaiters(requestId: string): void {
    const waiters = this.#printerWaiters.get(requestId) ?? [];
    this.#printerWaiters.delete(requestId);
    for (const done of waiters) done();
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
        for (const runActorId of watchingRuns(this.#sql, gatewayId, [
          change.device.sourceKey,
        ]))
          this.#forward(runActorId, {
            kind: "fault",
            sourceKey: change.device.sourceKey,
            faultCode: change.device.faultCode,
            at: now,
          });
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
    // A print that waits for this socket's answer stops waiting: it stays
    // `sent`, and the gateway's next hello settles it from its journal.
    for (const requestId of [...this.#printerWaiters.keys()])
      this.#releasePrinterWaiters(requestId);
    if (!replaced) {
      markGatewayCollectionsUnknown(this.#sql, attachment.gatewayId, now);
      await this.#cobotConnectionLost(scope, attachment.gatewayId, now);
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
    prunePrinterJobs(this.#sql, now);
    pruneCobotDispatches(this.#sql, now);
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

  #sendRawTo(socket: WebSocket, messageJson: string): void {
    try {
      socket.send(messageJson);
    } catch {
      // The gateway left. Its next hello sends the task again.
    }
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

declare module "@purin-labs/kernel/env" {
  interface Env {
    DEVICE_FLEET?: DurableObjectNamespace<DeviceFleetActor>;
  }
}
