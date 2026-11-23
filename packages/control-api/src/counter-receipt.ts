import { Type, type Static } from "typebox";
import { NonNegativeInteger } from "@purin-labs/contract-schema";
import { Value } from "typebox/value";

import {
  printerOutcomeSchema,
  printerTaskSchema,
  type PrinterTask,
} from "./device-gateway.ts";

/**
 * The receipt printer of a café counter (Plan 90 Phase 5): its binding, the
 * state of each print or drawer task and the receipt settings. A print error
 * never changes a sale; the Register shows it and offers the browser print.
 */

const strict = { additionalProperties: false } as const;
const text = Type.String({ minLength: 1, maxLength: 200 });

/** A Japanese Qualified Invoice registration number: T and 13 digits. */
export const INVOICE_REGISTRATION_NUMBER_PATTERN = "^T[0-9]{13}$";

export function isInvoiceRegistrationNumber(value: unknown): value is string {
  return (
    typeof value === "string" &&
    new RegExp(INVOICE_REGISTRATION_NUMBER_PATTERN, "u").test(value)
  );
}

export const counterPrinterJobStateSchema = Type.Union([
  /** Sent to the gateway, with no answer yet. */
  Type.Literal("sent"),
  printerOutcomeSchema,
  /** No active receipt printer is bound to this counter's location. */
  Type.Literal("no_printer"),
  /** The printer's gateway has no connection now, so nothing was sent. */
  Type.Literal("gateway_offline"),
]);
export type CounterPrinterJobState = Static<
  typeof counterPrinterJobStateSchema
>;

export const counterPrinterJobSchema = Type.Object(
  {
    requestId: text,
    task: printerTaskSchema,
    state: counterPrinterJobStateSchema,
    replayed: Type.Boolean(),
    createdAt: Type.Union([Type.Null(), NonNegativeInteger]),
    updatedAt: Type.Union([Type.Null(), NonNegativeInteger]),
  },
  strict,
);
export type CounterPrinterJob = Static<typeof counterPrinterJobSchema>;

export const counterReceiptPrinterSchema = Type.Object(
  {
    deviceId: text,
    name: text,
    drawer: Type.Boolean(),
    connected: Type.Boolean(),
  },
  strict,
);
export type CounterReceiptPrinter = Static<typeof counterReceiptPrinterSchema>;

export const counterSaleReceiptSchema = Type.Object(
  {
    ok: Type.Literal(true),
    /** Null when no active printer is bound: the browser prints. */
    printer: Type.Union([Type.Null(), counterReceiptPrinterSchema]),
    jobs: Type.Array(counterPrinterJobSchema),
  },
  strict,
);
export type CounterSaleReceipt = Static<typeof counterSaleReceiptSchema>;

export const counterReceiptPrintResponseSchema = Type.Object(
  { ok: Type.Literal(true), job: counterPrinterJobSchema },
  strict,
);
export type CounterReceiptPrintResponse = Static<
  typeof counterReceiptPrintResponseSchema
>;

export const counterReceiptSettingsSchema = Type.Object(
  {
    pantryLocationId: text,
    invoiceRegistrationNumber: Type.Union([
      Type.Null(),
      Type.String({ pattern: INVOICE_REGISTRATION_NUMBER_PATTERN }),
    ]),
  },
  strict,
);
export type CounterReceiptSettings = Static<
  typeof counterReceiptSettingsSchema
>;

export function parseCounterSaleReceipt(
  raw: unknown,
): CounterSaleReceipt | null {
  return Value.Check(counterSaleReceiptSchema, raw) ? raw : null;
}

export function parseCounterReceiptPrintResponse(
  raw: unknown,
): CounterReceiptPrintResponse | null {
  return Value.Check(counterReceiptPrintResponseSchema, raw) ? raw : null;
}

export function parseCounterReceiptSettings(
  raw: unknown,
): CounterReceiptSettings | null {
  return Value.Check(counterReceiptSettingsSchema, raw) ? raw : null;
}

/** Whether the paper came out or the drawer opened. */
export function counterPrinterJobDone(job: CounterPrinterJob): boolean {
  return job.state === "done";
}

/** What the Register tells the person about a task, in plain words. */
export function counterPrinterJobMessage(job: CounterPrinterJob): string {
  const thing: Record<PrinterTask, string> = {
    receipt_print: "The receipt",
    cash_drawer_kick: "The cash drawer",
  };
  switch (job.state) {
    case "done":
      return job.task === "receipt_print"
        ? "The receipt printed."
        : "The cash drawer opened.";
    case "sent":
      return `${thing[job.task]} request went to the printer, which did not answer yet. Look at the printer before you try again.`;
    case "offline":
      return "The printer does not answer on the shop network. Check its power and network cable.";
    case "paper_out":
      return "The printer has no paper. Put in a new roll, then print again.";
    case "cover_open":
      return "The printer cover is open. Close it, then print again.";
    case "no_drawer":
      return "No cash drawer is connected to the printer. Open the drawer with its key.";
    case "unknown_device":
      return "The shop gateway does not know this printer. Check the printer list on the gateway computer.";
    case "result_unknown":
      return job.task === "receipt_print"
        ? "The printer stopped during the print. Look at the printer: the receipt may have printed."
        : "The printer stopped during the request. Look at the cash drawer: it may have opened.";
    case "no_printer":
      return "No receipt printer is set up for this counter.";
    case "gateway_offline":
      return "The shop gateway is offline, so the printer did not get the request.";
  }
}
