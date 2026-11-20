import type {
  CounterPrinterJob,
  CounterPrinterJobState,
  GatewayMessage,
  PrinterOutcome,
  PrinterTask,
} from "@purin-labs/control-api";

/**
 * The receipt printer tasks of one shop location inside DeviceFleetActor
 * (Plan 90 Phase 5). A task is one row from its send until the gateway
 * answers. The gateway's own journal makes a repeated `requestId` print or
 * open the drawer at most one time, so this side can send an unanswered task
 * again after a socket drop. A task gets one more send only while it is young:
 * a receipt or a drawer that comes minutes later surprises the person at the
 * counter. An older unanswered task ends as `result_unknown`.
 *
 * An idle shop writes nothing here: a row starts with a person's print or a
 * cash sale, and the daily upkeep deletes rows after seven days.
 */

/** An unanswered task goes again at the gateway's next hello for this long. */
export const PRINTER_JOB_RESEND_MS = 60_000;
/** The settled tasks stay this long, for the Register and the Devices page. */
const PRINTER_JOB_RETENTION_MS = 7 * 24 * 60 * 60_000;

type PrinterJobRow = Readonly<{
  request_id: string;
  gateway_id: string;
  source_key: string;
  task: string;
  checkout_id: string;
  message_json: string;
  state: string;
  replayed: number;
  created_at: number;
  updated_at: number;
}>;

export type PrinterJobRecord = Readonly<{
  requestId: string;
  gatewayId: string;
  sourceKey: string;
  task: PrinterTask;
  checkoutId: string;
  /** The exact message, so a second send is the same request. */
  messageJson: string;
  state: "sent" | PrinterOutcome;
  replayed: boolean;
  createdAt: number;
  updatedAt: number;
}>;

export function printerJobSchemaStatements(): readonly string[] {
  return [
    `CREATE TABLE IF NOT EXISTS printer_job (
       request_id TEXT PRIMARY KEY,
       gateway_id TEXT NOT NULL,
       source_key TEXT NOT NULL,
       task TEXT NOT NULL CHECK (task IN ('receipt_print', 'cash_drawer_kick')),
       checkout_id TEXT NOT NULL,
       message_json TEXT NOT NULL,
       state TEXT NOT NULL CHECK (state IN (
         'sent', 'done', 'offline', 'paper_out', 'cover_open', 'no_drawer',
         'unknown_device', 'result_unknown'
       )),
       replayed INTEGER NOT NULL CHECK (replayed IN (0, 1)),
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS printer_job_checkout
       ON printer_job (checkout_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS printer_job_open
       ON printer_job (gateway_id, state)`,
  ];
}

const COLUMNS = `request_id, gateway_id, source_key, task, checkout_id,
  message_json, state, replayed, created_at, updated_at`;

export function readPrinterJob(
  sql: SqlStorage,
  requestId: string,
): PrinterJobRecord | null {
  const row = sql
    .exec<PrinterJobRow>(
      `SELECT ${COLUMNS} FROM printer_job WHERE request_id = ?`,
      requestId,
    )
    .toArray()[0];
  return row === undefined ? null : toRecord(row);
}

export function insertPrinterJob(
  sql: SqlStorage,
  input: Readonly<{
    requestId: string;
    gatewayId: string;
    sourceKey: string;
    task: PrinterTask;
    checkoutId: string;
    messageJson: string;
  }>,
  now: number,
): void {
  sql.exec(
    `INSERT INTO printer_job (${COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, 'sent', 0, ?, ?)`,
    input.requestId,
    input.gatewayId,
    input.sourceKey,
    input.task,
    input.checkoutId,
    input.messageJson,
    now,
    now,
  );
}

/** Settles the task of one answer. An answer for an unknown task changes nothing. */
export function recordPrinterResult(
  sql: SqlStorage,
  gatewayId: string,
  message: Extract<GatewayMessage, Readonly<{ type: "printer_result" }>>,
  now: number,
): PrinterJobRecord | null {
  const job = readPrinterJob(sql, message.requestId);
  if (
    job === null ||
    job.gatewayId !== gatewayId ||
    job.sourceKey !== message.sourceKey ||
    job.state !== "sent"
  )
    return null;
  sql.exec(
    `UPDATE printer_job SET state = ?, replayed = ?, updated_at = ?
      WHERE request_id = ? AND state = 'sent'`,
    message.outcome,
    message.replayed ? 1 : 0,
    now,
    message.requestId,
  );
  return readPrinterJob(sql, message.requestId);
}

/**
 * The unanswered tasks of a gateway that just said hello. The young ones go
 * again; the old ones end as `result_unknown`, so nothing prints late.
 */
export function reopenPrinterJobs(
  sql: SqlStorage,
  gatewayId: string,
  now: number,
): readonly PrinterJobRecord[] {
  const open = sql
    .exec<PrinterJobRow>(
      `SELECT ${COLUMNS} FROM printer_job
        WHERE gateway_id = ? AND state = 'sent' ORDER BY created_at`,
      gatewayId,
    )
    .toArray()
    .map(toRecord);
  const resend: PrinterJobRecord[] = [];
  for (const job of open) {
    if (now - job.createdAt <= PRINTER_JOB_RESEND_MS) {
      resend.push(job);
      continue;
    }
    sql.exec(
      `UPDATE printer_job SET state = 'result_unknown', updated_at = ?
        WHERE request_id = ? AND state = 'sent'`,
      now,
      job.requestId,
    );
  }
  return resend;
}

export function listCheckoutPrinterJobs(
  sql: SqlStorage,
  checkoutId: string,
): readonly PrinterJobRecord[] {
  return sql
    .exec<PrinterJobRow>(
      `SELECT ${COLUMNS} FROM printer_job
        WHERE checkout_id = ? ORDER BY created_at, request_id`,
      checkoutId,
    )
    .toArray()
    .map(toRecord);
}

export function prunePrinterJobs(sql: SqlStorage, now: number): void {
  sql.exec(
    "DELETE FROM printer_job WHERE state != 'sent' AND updated_at < ?",
    now - PRINTER_JOB_RETENTION_MS,
  );
}

export function deleteGatewayPrinterJobs(
  sql: SqlStorage,
  gatewayId: string,
): void {
  sql.exec("DELETE FROM printer_job WHERE gateway_id = ?", gatewayId);
}

/** What the Register shows of one task. */
export function printerJobView(job: PrinterJobRecord): CounterPrinterJob {
  return {
    requestId: job.requestId,
    task: job.task,
    state: job.state,
    replayed: job.replayed,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

/** A task that did not reach a printer, and so has no row. */
export function unsentPrinterJob(
  requestId: string,
  task: PrinterTask,
  state: Extract<
    CounterPrinterJobState,
    "no_printer" | "no_drawer" | "gateway_offline"
  >,
): CounterPrinterJob {
  return {
    requestId,
    task,
    state,
    replayed: false,
    createdAt: null,
    updatedAt: null,
  };
}

function toRecord(row: PrinterJobRow): PrinterJobRecord {
  return {
    requestId: row.request_id,
    gatewayId: row.gateway_id,
    sourceKey: row.source_key,
    task: row.task as PrinterTask,
    checkoutId: row.checkout_id,
    messageJson: row.message_json,
    state: row.state as PrinterJobRecord["state"],
    replayed: row.replayed === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
