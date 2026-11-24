import type {
  CobotClockEntry,
  CobotReport,
  CobotTaskMessage,
  CobotTaskState,
  CounterPrinterJob,
  CounterReceiptPrinter,
  PlatformGatewayMessage,
  PrinterTask,
  ReceiptLayout,
  TerminalPaymentMethod,
} from "@purin-labs/control-api";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";

export type GatewayPresence = Readonly<{
  gatewayId: string;
  lastHeardAt: number | null;
  socketOpen: boolean;
}>;

export type DeviceCommandKind = "pause" | "resume";

export type DeviceSample = Readonly<{
  name: string;
  value: number;
  unit: string;
  at: number;
}>;

/**
 * Per-terminal exclusive collection state inside DeviceFleetActor (Plan 90 D7).
 * A LAN payment terminal runs at most one collection at a time, and locks in
 * `result_unknown` on an indeterminate LAN timeout or socket drop until
 * inquired or explicitly cleared — never re-charging.
 */
export type TerminalCollectionState =
  "collecting" | "result_unknown" | "captured" | "declined" | "cancelled";

export type TerminalCollectionRecord = Readonly<{
  gatewayId: string;
  sourceKey: string;
  requestId: string;
  paymentAttemptId: string;
  checkoutId: string;
  amountMinor: number;
  currency: string;
  paymentMethod: TerminalPaymentMethod;
  state: TerminalCollectionState;
  providerPaymentReference: string | null;
  tenderBrand: string | null;
  providerRefundable: boolean | null;
  reasonCode: string | null;
  expiresAt: string;
  updatedAt: number;
}>;

export type StartTerminalCollectionInput = Readonly<{
  gatewayId: string;
  sourceKey: string;
  requestId: string;
  paymentAttemptId: string;
  checkoutId: string;
  amountMinor: number;
  currency: string;
  paymentMethod: TerminalPaymentMethod;
  expiresAt: string;
}>;

export type StartTerminalCollectionResult =
  | Readonly<{ ok: true; record: TerminalCollectionRecord; replayed: boolean }>
  | Readonly<{
      ok: false;
      reason: "terminal_busy" | "result_unknown" | "gateway_offline";
      active: TerminalCollectionRecord | null;
    }>;

export type CobotDispatchState =
  "sent" | "unsent" | CobotTaskState | "result_unknown";

export type CobotDispatchRecord = Readonly<{
  requestId: string;
  gatewayId: string;
  deviceId: string;
  sourceKey: string;
  runActorId: string;
  runId: string;
  taskId: string;
  message: CobotTaskMessage;
  state: CobotDispatchState;
  lastReport: CobotReport | null;
  createdAt: number;
  updatedAt: number;
}>;

/** Who approved a run, as each dispatch of the run names it (Plan 24). */
export type CobotDispatchApproval = Readonly<{
  by: string;
  role: string;
  via: string;
  at: number;
}>;

/**
 * The RPC methods of the class DeviceFleetActor that its callers use through
 * the stub. The class gives the comment of each method.
 */
export interface DeviceFleetRpc extends Rpc.DurableObjectBranded {
  presence(): readonly GatewayPresence[];
  sendToGateway(gatewayId: string, message: PlatformGatewayMessage): boolean;
  sendDeviceCommand(
    input: Readonly<{
      gatewayId: string;
      deviceId: string;
      message: Extract<
        PlatformGatewayMessage,
        Readonly<{ type: DeviceCommandKind }>
      >;
    }>,
  ): boolean;
  closeGateway(gatewayId: string): void;
  runPrinterTask(
    input: Readonly<{
      task: PrinterTask;
      requestId: string;
      checkoutId: string;
      receipt: ReceiptLayout | null;
    }>,
  ): Promise<CounterPrinterJob>;
  counterPrinter(): Promise<CounterReceiptPrinter | null>;
  printerJobs(checkoutId: string): readonly CounterPrinterJob[];
  startTerminalCollection(
    input: StartTerminalCollectionInput,
  ): StartTerminalCollectionResult;
  cancelTerminalCollection(
    input: Readonly<{
      gatewayId: string;
      sourceKey: string;
      requestId: string;
      paymentAttemptId: string;
    }>,
  ): boolean;
  inquireTerminalCollection(
    input: Readonly<{
      gatewayId: string;
      sourceKey: string;
      requestId: string;
      paymentAttemptId: string;
    }>,
  ): boolean;
  readTerminalCollection(
    gatewayId: string,
    sourceKey: string,
  ): TerminalCollectionRecord | null;
  dispatchCobotTask(
    input: Readonly<{
      gatewayId: string;
      deviceId: string;
      runActorId: string;
      message: CobotTaskMessage;
      approval: CobotDispatchApproval;
    }>,
  ): Promise<
    Readonly<{ state: CobotDispatchState | "refused"; replayed: boolean }>
  >;
  cobotDispatches(runActorId: string): readonly CobotDispatchRecord[];
  readCobotClocks(
    gatewayId: string,
  ): Promise<readonly CobotClockEntry[] | null>;
  watchCobotRun(
    runActorId: string,
    devices: readonly Readonly<{ gatewayId: string; sourceKey: string }>[],
  ): void;
  unwatchCobotRun(runActorId: string): void;
  deviceRevoked(gatewayId: string, sourceKey: string): void;
  refresh(): Promise<void>;
  samples(
    gatewayId: string,
    sourceKey: string,
    limit: number,
  ): readonly DeviceSample[];
  erase(): Promise<void>;
}

/** The Actor of one shop location, placed where the Organisation is. */
export function deviceFleetStub(
  env: Env,
  scope: OrganisationExecutionScope,
  locationId: string,
): DurableObjectStub<DeviceFleetRpc> | null {
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
  namespace: DurableObjectNamespace<DeviceFleetRpc>,
  organisationId: OrganisationId,
  placement: OrganisationExecutionScope["placement"],
  locationId: string,
): DurableObjectStub<DeviceFleetRpc> {
  const placed =
    placement.kind === "residency"
      ? namespace.jurisdiction(placement.residencyJurisdiction)
      : namespace;
  return placed.get(
    placed.idFromName(`device_fleet:${organisationId}:${locationId}`),
    { locationHint: placement.locationHint },
  );
}
