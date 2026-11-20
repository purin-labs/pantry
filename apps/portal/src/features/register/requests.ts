import {
  parseCounterReceiptPrintResponse,
  parseCounterSaleReceipt,
  type CounterPrinterJob,
  type CounterSaleReceipt,
} from "@purin-labs/control-api";

import { controlMutation, controlRead } from "../../control-client";

/** The Register's reads and changes of the Platform for a receipt. */

export async function readSaleReceipt(
  organisationId: string,
  checkoutId: string,
): Promise<CounterSaleReceipt> {
  const read = parseCounterSaleReceipt(
    await controlRead(`${salePath(organisationId, checkoutId)}/receipt`),
  );
  if (read === null) throw new Error("The receipt printer could not be read.");
  return read;
}

export async function printOnPrinter(
  organisationId: string,
  checkoutId: string,
  copy: "original" | "reprint",
): Promise<CounterPrinterJob> {
  const printed = parseCounterReceiptPrintResponse(
    await controlMutation(
      `${salePath(organisationId, checkoutId)}/receipt-print`,
      "POST",
      { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, copy },
      undefined,
      // Each press is one print. A retry of the same press prints nothing more.
      {
        kind: "prepared",
        idempotencyKey: `counter-receipt:${checkoutId}:${crypto.randomUUID()}`,
      },
    ),
  );
  if (printed === null) throw new Error("The print answer could not be read.");
  return printed.job;
}

function salePath(organisationId: string, checkoutId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/counter-sales/${encodeURIComponent(checkoutId)}`;
}
