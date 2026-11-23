import { Type, type Static } from "typebox";
import { PositiveInteger } from "@purin-labs/contract-schema";
import { Value } from "typebox/value";

import {
  cobotClockMessageSchema,
  cobotClockReadMessageSchema,
  cobotInquireMessageSchema,
  cobotObservedMessageSchema,
  cobotReportMessageSchema,
  cobotTaskMessageSchema,
  deviceStopMessageSchema,
} from "./device-cobot.ts";
import { shortText, sourceKey, strict } from "./device-shapes.ts";

/**
 * The protocol of a shop gateway (Plan 85): a small computer in the shop that
 * connects its devices to Pantry. The gateway dials out and holds one socket.
 * Only Plan 24's operations cross this boundary: read health, reserve, submit
 * a bounded task, request a pause and read a receipt. The protocol has no
 * shell, no file transfer and no raw motion command. The cobot task messages
 * are in `device-cobot.ts`.
 */

/** One batched heartbeat every 30 s. */
export const DEVICE_GATEWAY_HEARTBEAT_MS = 30_000;
/** A connection with no message for this long is quiet. */
export const DEVICE_CONNECTION_QUIET_MS = 90_000;
/** A connection with no message for this long is offline. */
export const DEVICE_CONNECTION_OFFLINE_MS = 180_000;
/** The enrollment code works one time, for this long. */
export const DEVICE_GATEWAY_CODE_TTL_MS = 15 * 60_000;
/** A gateway below this version needs attention. */
export const DEVICE_GATEWAY_MINIMUM_VERSION = "0.1.0";
/** One gateway reports at most this many devices. */
export const DEVICE_GATEWAY_DEVICE_LIMIT = 64;
/** A larger message from a gateway is refused. */
export const DEVICE_GATEWAY_MESSAGE_BYTES = 64 * 1024;

export const deviceKindSchema = Type.Union([
  Type.Literal("cobot"),
  Type.Literal("appliance"),
  Type.Literal("servo"),
  Type.Literal("relay"),
  Type.Literal("camera"),
  Type.Literal("payment_terminal"),
  Type.Literal("receipt_printer"),
  Type.Literal("other"),
]);
export type DeviceHardwareKind = Static<typeof deviceKindSchema>;

export const terminalPaymentMethodSchema = Type.Union([
  Type.Literal("card"),
  Type.Literal("felica"),
  Type.Literal("qr_code"),
]);
export type TerminalPaymentMethod = Static<typeof terminalPaymentMethodSchema>;

export const terminalCollectionOutcomeSchema = Type.Union([
  Type.Literal("captured"),
  Type.Literal("declined"),
  Type.Literal("cancelled"),
  Type.Literal("indeterminate"),
]);
export type TerminalCollectionOutcome = Static<
  typeof terminalCollectionOutcomeSchema
>;

/** Characters on one line of 72 mm print (80 mm paper), Plan 90 Phase 5. */
export const RECEIPT_COLUMNS = 48;

/**
 * A receipt as lines. Pantry lays it out; the gateway encodes it for its
 * printer (StarPRNT for a Star mC-Print3) and keeps the printer's address.
 */
export const receiptLineSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("text"),
      text: Type.String({ maxLength: 200 }),
      align: Type.Union([
        Type.Literal("left"),
        Type.Literal("center"),
        Type.Literal("right"),
      ]),
      emphasis: Type.Boolean(),
      size: Type.Union([Type.Literal("normal"), Type.Literal("double")]),
    },
    strict,
  ),
  /** A left text and a right text on one line, for an item and its price. */
  Type.Object(
    {
      kind: Type.Literal("columns"),
      left: Type.String({ maxLength: 200 }),
      right: Type.String({ maxLength: 60 }),
      emphasis: Type.Boolean(),
    },
    strict,
  ),
  Type.Object({ kind: Type.Literal("rule") }, strict),
  Type.Object(
    {
      kind: Type.Literal("feed"),
      lines: Type.Integer({ minimum: 1, maximum: 5 }),
    },
    strict,
  ),
]);
export type ReceiptLine = Static<typeof receiptLineSchema>;

export const receiptLayoutSchema = Type.Object(
  {
    columns: Type.Literal(RECEIPT_COLUMNS),
    lines: Type.Array(receiptLineSchema, { minItems: 1, maxItems: 160 }),
  },
  strict,
);
export type ReceiptLayout = Static<typeof receiptLayoutSchema>;

export const printerTaskSchema = Type.Union([
  Type.Literal("receipt_print"),
  Type.Literal("cash_drawer_kick"),
]);
export type PrinterTask = Static<typeof printerTaskSchema>;

/**
 * What a printer task did. Only `done` printed or opened the drawer. A
 * `result_unknown` task stopped after its first byte, so the paper may exist.
 */
export const printerOutcomeSchema = Type.Union([
  Type.Literal("done"),
  Type.Literal("offline"),
  Type.Literal("paper_out"),
  Type.Literal("cover_open"),
  Type.Literal("no_drawer"),
  Type.Literal("unknown_device"),
  Type.Literal("result_unknown"),
]);
export type PrinterOutcome = Static<typeof printerOutcomeSchema>;

export const deviceHealthSchema = Type.Union([
  Type.Literal("ok"),
  Type.Literal("warning"),
  Type.Literal("fault"),
  Type.Literal("not_reported"),
]);
export type DeviceHealth = Static<typeof deviceHealthSchema>;

export const deviceCapabilitySchema = Type.Object(
  {
    id: shortText,
    label: shortText,
    revision: PositiveInteger,
  },
  strict,
);
export type DeviceCapability = Static<typeof deviceCapabilitySchema>;

/** A device as its gateway reports it. Each text is untrusted. */
const foundDeviceSchema = Type.Object(
  {
    sourceKey,
    kind: deviceKindSchema,
    suggestedName: shortText,
    model: shortText,
    serial: Type.Union([Type.Null(), shortText]),
    firmwareVersion: Type.Union([Type.Null(), shortText]),
    capabilities: Type.Array(deviceCapabilitySchema, { maxItems: 32 }),
  },
  strict,
);
export type FoundDevice = Static<typeof foundDeviceSchema>;

const healthReportSchema = Type.Object(
  {
    sourceKey,
    health: deviceHealthSchema,
    faultCode: Type.Union([
      Type.Null(),
      Type.String({ minLength: 1, maxLength: 16, pattern: "^[A-Z0-9_-]+$" }),
    ]),
    faultText: Type.Union([
      Type.Null(),
      Type.String({ minLength: 1, maxLength: 500 }),
    ]),
  },
  strict,
);
export type DeviceHealthReport = Static<typeof healthReportSchema>;

const sampleSchema = Type.Object(
  {
    sourceKey,
    name: Type.String({ minLength: 1, maxLength: 40 }),
    value: Type.Number(),
    unit: Type.String({ minLength: 1, maxLength: 12 }),
  },
  strict,
);
export type DeviceSampleReport = Static<typeof sampleSchema>;

export const gatewayMessageSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal("hello"),
      serviceVersion: shortText,
      devices: Type.Array(foundDeviceSchema, {
        maxItems: DEVICE_GATEWAY_DEVICE_LIMIT,
      }),
      health: Type.Array(healthReportSchema, {
        maxItems: DEVICE_GATEWAY_DEVICE_LIMIT,
      }),
    },
    strict,
  ),
  Type.Object({ type: Type.Literal("heartbeat") }, strict),
  Type.Object(
    {
      type: Type.Literal("health"),
      reports: Type.Array(healthReportSchema, {
        minItems: 1,
        maxItems: DEVICE_GATEWAY_DEVICE_LIMIT,
      }),
    },
    strict,
  ),
  Type.Object(
    {
      type: Type.Literal("samples"),
      samples: Type.Array(sampleSchema, { minItems: 1, maxItems: 256 }),
    },
    strict,
  ),
  Type.Object(
    {
      type: Type.Literal("ack"),
      requestId: shortText,
      outcome: Type.Union([Type.Literal("done"), Type.Literal("refused")]),
    },
    strict,
  ),
  Type.Object(
    {
      type: Type.Literal("terminal_result"),
      requestId: shortText,
      sourceKey,
      paymentAttemptId: shortText,
      outcome: terminalCollectionOutcomeSchema,
      providerPaymentReference: Type.Union([Type.Null(), shortText]),
      paymentMethod: Type.Union([Type.Null(), terminalPaymentMethodSchema]),
      tenderBrand: Type.Union([Type.Null(), shortText]),
      providerRefundable: Type.Union([Type.Null(), Type.Boolean()]),
      reasonCode: Type.Union([Type.Null(), shortText]),
    },
    strict,
  ),
  /** The answer to `receipt_print` or `cash_drawer_kick`, from the journal. */
  Type.Object(
    {
      type: Type.Literal("printer_result"),
      requestId: shortText,
      sourceKey,
      task: printerTaskSchema,
      outcome: printerOutcomeSchema,
      /** The gateway had answered this request before and did nothing now. */
      replayed: Type.Boolean(),
    },
    strict,
  ),
  cobotReportMessageSchema,
  cobotClockMessageSchema,
  cobotObservedMessageSchema,
]);
export type GatewayMessage = Static<typeof gatewayMessageSchema>;

export const platformGatewayMessageSchema = Type.Union([
  Type.Object({ type: Type.Literal("welcome"), gatewayId: shortText }, strict),
  Type.Object(
    {
      type: Type.Literal("pause"),
      requestId: shortText,
      sourceKey,
    },
    strict,
  ),
  Type.Object(
    {
      type: Type.Literal("resume"),
      requestId: shortText,
      sourceKey,
    },
    strict,
  ),
  /** One still image from a camera, when the Organisation has them on. */
  Type.Object(
    {
      type: Type.Literal("snapshot"),
      requestId: shortText,
      sourceKey,
    },
    strict,
  ),
  /** A report about a device that this gateway does not hold. */
  Type.Object(
    {
      type: Type.Literal("refused"),
      reason: Type.Literal("unknown_device"),
      sourceKey,
    },
    strict,
  ),
  Type.Object(
    {
      type: Type.Literal("terminal_collect"),
      requestId: shortText,
      sourceKey,
      paymentAttemptId: shortText,
      amountMinor: PositiveInteger,
      currency: Type.String({ pattern: "^[A-Z]{3}$" }),
      paymentMethod: terminalPaymentMethodSchema,
      expiresAt: shortText,
    },
    strict,
  ),
  Type.Object(
    {
      type: Type.Literal("terminal_cancel"),
      requestId: shortText,
      sourceKey,
      paymentAttemptId: shortText,
    },
    strict,
  ),
  Type.Object(
    {
      type: Type.Literal("terminal_inquire"),
      requestId: shortText,
      sourceKey,
      paymentAttemptId: shortText,
    },
    strict,
  ),
  /** One receipt. The same `requestId` never prints twice (Plan 90 D8). */
  Type.Object(
    {
      type: Type.Literal("receipt_print"),
      requestId: shortText,
      sourceKey,
      receipt: receiptLayoutSchema,
    },
    strict,
  ),
  /** Opens the cash drawer on the printer's DK port, one time per request. */
  Type.Object(
    {
      type: Type.Literal("cash_drawer_kick"),
      requestId: shortText,
      sourceKey,
    },
    strict,
  ),
  cobotTaskMessageSchema,
  cobotInquireMessageSchema,
  cobotClockReadMessageSchema,
  deviceStopMessageSchema,
]);
export type PlatformGatewayMessage = Static<
  typeof platformGatewayMessageSchema
>;

export const deviceGatewayEnrollRequestSchema = Type.Object(
  {
    organisationId: Type.String({ minLength: 1, maxLength: 128 }),
    gatewayId: Type.String({ pattern: "^dgw_[a-f0-9]{24}$" }),
    code: Type.String({ minLength: 43, maxLength: 43 }),
  },
  strict,
);
export type DeviceGatewayEnrollRequest = Static<
  typeof deviceGatewayEnrollRequestSchema
>;

export const deviceGatewayEnrollResponseSchema = Type.Object(
  { credential: Type.String({ minLength: 1 }) },
  strict,
);
export type DeviceGatewayEnrollResponse = Static<
  typeof deviceGatewayEnrollResponseSchema
>;

export function parseGatewayMessage(raw: unknown): GatewayMessage | null {
  return Value.Check(gatewayMessageSchema, raw) ? raw : null;
}

export function parseDeviceGatewayEnrollRequest(
  raw: unknown,
): DeviceGatewayEnrollRequest | null {
  return Value.Check(deviceGatewayEnrollRequestSchema, raw) ? raw : null;
}

/** Whether `version` is at least `minimum`, comparing each dotted number. */
export function deviceGatewayVersionIsCurrent(
  version: string,
  minimum: string = DEVICE_GATEWAY_MINIMUM_VERSION,
): boolean {
  const have = version.split(".").map(Number);
  const want = minimum.split(".").map(Number);
  for (let index = 0; index < want.length; index += 1) {
    const left = have[index] ?? 0;
    const right = want[index] ?? 0;
    if (!Number.isFinite(left)) return false;
    if (left !== right) return left > right;
  }
  return true;
}
