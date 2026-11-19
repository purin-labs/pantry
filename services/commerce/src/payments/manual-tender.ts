// Money that staff took outside a payment provider (Plan 77 step 2): cash at
// the counter, or a bank transfer with the reference on the statement. The
// tender belongs to one captured payment. Commerce resolves a refund of
// that payment itself, and staff return the money the same way.
import type { CommerceManualTenderV1 } from "@seams/commerce-client";

import type { CommerceDatabase } from "../database.ts";

export type ManualTender = CommerceManualTenderV1 &
  Readonly<{
    paymentId: string;
    orderId: string;
    amountMinor: number;
    currency: string;
    cashReceivedMinor?: number;
    changeDueMinor?: number;
    recordedAt: string;
  }>;

type ManualTenderRow = Readonly<{
  paymentId: string;
  orderId: string;
  method: "cash" | "bank_transfer";
  reference: string | null;
  amountMinor: number;
  currency: string;
  cashReceivedMinor: number | null;
  changeDueMinor: number | null;
  recordedAt: string;
}>;

const COLUMNS = `payment_id AS paymentId, order_id AS orderId, method,
  reference, amount_minor AS amountMinor, currency,
  cash_received_minor AS cashReceivedMinor,
  change_due_minor AS changeDueMinor,
  recorded_at AS recordedAt`;

export function writeManualTender(
  database: CommerceDatabase,
  merchantId: string,
  tender: ManualTender,
): void {
  database
    .prepare(
      `INSERT INTO manual_tender (
         merchant_id, payment_id, order_id, method, reference, amount_minor,
         currency, cash_received_minor, change_due_minor, recorded_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      merchantId,
      tender.paymentId,
      tender.orderId,
      tender.method,
      tender.method === "bank_transfer" ? tender.reference : null,
      tender.amountMinor,
      tender.currency,
      tender.cashReceivedMinor ?? null,
      tender.changeDueMinor ?? null,
      tender.recordedAt,
    );
}

/** The manual tender of a payment, or undefined for any other payment. */
export function readManualTender(
  database: CommerceDatabase,
  merchantId: string,
  paymentId: string,
): ManualTender | undefined {
  const row = database
    .prepare(
      `SELECT ${COLUMNS} FROM manual_tender
       WHERE merchant_id = ? AND payment_id = ?`,
    )
    .get<ManualTenderRow>(merchantId, paymentId);
  return row === undefined ? undefined : manualTender(row);
}

export function listManualTendersForOrder(
  database: CommerceDatabase,
  merchantId: string,
  orderId: string,
): readonly ManualTender[] {
  return database
    .prepare(
      `SELECT ${COLUMNS} FROM manual_tender
       WHERE merchant_id = ? AND order_id = ?
       ORDER BY recorded_at, payment_id`,
    )
    .all<ManualTenderRow>(merchantId, orderId)
    .map(manualTender);
}

function manualTender(row: ManualTenderRow): ManualTender {
  const common = {
    paymentId: row.paymentId,
    orderId: row.orderId,
    amountMinor: row.amountMinor,
    currency: row.currency,
    recordedAt: row.recordedAt,
  };
  if (row.method === "cash") {
    return {
      ...common,
      method: "cash",
      ...(row.cashReceivedMinor !== null && row.changeDueMinor !== null
        ? {
            cashReceivedMinor: row.cashReceivedMinor,
            changeDueMinor: row.changeDueMinor,
          }
        : {}),
    };
  }
  if (row.reference === null)
    throw new Error(`Bank transfer ${row.paymentId} has no reference`);
  return { ...common, method: "bank_transfer", reference: row.reference };
}
