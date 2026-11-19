import type {
  GatewayMessage,
  TerminalPaymentMethod,
} from "@seams/control-api";

/**
 * Per-terminal exclusive collection state inside DeviceFleetActor (Plan 90 D7).
 * A LAN payment terminal runs at most one collection at a time, and locks in
 * `result_unknown` on an indeterminate LAN timeout or socket drop until
 * inquired or explicitly cleared — never re-charging.
 */
export type TerminalCollectionState =
  | "collecting"
  | "result_unknown"
  | "captured"
  | "declined"
  | "cancelled";

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

type TerminalCollectionRow = Readonly<{
  gateway_id: string;
  source_key: string;
  request_id: string;
  payment_attempt_id: string;
  checkout_id: string;
  amount_minor: number;
  currency: string;
  payment_method: string;
  state: string;
  provider_payment_reference: string | null;
  tender_brand: string | null;
  provider_refundable: number | null;
  reason_code: string | null;
  expires_at: string;
  updated_at: number;
}>;

export function terminalCollectionSchemaStatements(): readonly string[] {
  return [
    `CREATE TABLE IF NOT EXISTS terminal_collection (
       gateway_id TEXT NOT NULL,
       source_key TEXT NOT NULL,
       request_id TEXT NOT NULL,
       payment_attempt_id TEXT NOT NULL,
       checkout_id TEXT NOT NULL,
       amount_minor INTEGER NOT NULL,
       currency TEXT NOT NULL,
       payment_method TEXT NOT NULL,
       state TEXT NOT NULL CHECK (
         state IN ('collecting', 'result_unknown', 'captured', 'declined', 'cancelled')
       ),
       provider_payment_reference TEXT,
       tender_brand TEXT,
       provider_refundable INTEGER,
       reason_code TEXT,
       expires_at TEXT NOT NULL,
       updated_at INTEGER NOT NULL,
       PRIMARY KEY (gateway_id, source_key)
     )`,
  ];
}

export function readTerminalCollection(
  sql: SqlStorage,
  gatewayId: string,
  sourceKey: string,
): TerminalCollectionRecord | null {
  const row = sql
    .exec<TerminalCollectionRow>(
      `SELECT gateway_id, source_key, request_id, payment_attempt_id,
              checkout_id, amount_minor, currency, payment_method, state,
              provider_payment_reference, tender_brand, provider_refundable,
              reason_code, expires_at, updated_at
       FROM terminal_collection
       WHERE gateway_id = ? AND source_key = ?`,
      gatewayId,
      sourceKey,
    )
    .toArray()[0];
  return row === undefined ? null : toRecord(row);
}

export function reserveTerminalCollection(
  sql: SqlStorage,
  input: StartTerminalCollectionInput,
  now: number,
): StartTerminalCollectionResult {
  const existing = readTerminalCollection(sql, input.gatewayId, input.sourceKey);
  if (existing !== null) {
    if (existing.paymentAttemptId === input.paymentAttemptId) {
      return { ok: true, record: existing, replayed: true };
    }
    if (existing.state === "collecting") {
      return { ok: false, reason: "terminal_busy", active: existing };
    }
    if (existing.state === "result_unknown") {
      return { ok: false, reason: "result_unknown", active: existing };
    }
  }
  sql.exec(
    `INSERT INTO terminal_collection (
       gateway_id, source_key, request_id, payment_attempt_id, checkout_id,
       amount_minor, currency, payment_method, state,
       provider_payment_reference, tender_brand, provider_refundable,
       reason_code, expires_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'collecting', NULL, NULL, NULL, NULL, ?, ?)
     ON CONFLICT (gateway_id, source_key) DO UPDATE SET
       request_id = excluded.request_id,
       payment_attempt_id = excluded.payment_attempt_id,
       checkout_id = excluded.checkout_id,
       amount_minor = excluded.amount_minor,
       currency = excluded.currency,
       payment_method = excluded.payment_method,
       state = 'collecting',
       provider_payment_reference = NULL,
       tender_brand = NULL,
       provider_refundable = NULL,
       reason_code = NULL,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at`,
    input.gatewayId,
    input.sourceKey,
    input.requestId,
    input.paymentAttemptId,
    input.checkoutId,
    input.amountMinor,
    input.currency,
    input.paymentMethod,
    input.expiresAt,
    now,
  );
  const record = readTerminalCollection(sql, input.gatewayId, input.sourceKey);
  if (record === null) {
    throw new Error("Terminal collection reservation did not persist");
  }
  return { ok: true, record, replayed: false };
}

export function recordTerminalResult(
  sql: SqlStorage,
  gatewayId: string,
  message: Extract<GatewayMessage, Readonly<{ type: "terminal_result" }>>,
  now: number,
): TerminalCollectionRecord | null {
  const existing = readTerminalCollection(sql, gatewayId, message.sourceKey);
  if (
    existing === null ||
    existing.paymentAttemptId !== message.paymentAttemptId
  ) {
    return null;
  }
  const nextState: TerminalCollectionState =
    message.outcome === "indeterminate" ? "result_unknown" : message.outcome;
  sql.exec(
    `UPDATE terminal_collection
     SET state = ?,
         provider_payment_reference = ?,
         payment_method = COALESCE(?, payment_method),
         tender_brand = ?,
         provider_refundable = ?,
         reason_code = ?,
         updated_at = ?
     WHERE gateway_id = ? AND source_key = ? AND payment_attempt_id = ?`,
    nextState,
    message.providerPaymentReference,
    message.paymentMethod,
    message.tenderBrand,
    message.providerRefundable === null
      ? null
      : message.providerRefundable
        ? 1
        : 0,
    message.reasonCode,
    now,
    gatewayId,
    message.sourceKey,
    message.paymentAttemptId,
  );
  return readTerminalCollection(sql, gatewayId, message.sourceKey);
}

/**
 * Locks any in-flight collection on a disconnected gateway into
 * `result_unknown` so no new sale can re-charge the terminal before inquiry.
 */
export function markGatewayCollectionsUnknown(
  sql: SqlStorage,
  gatewayId: string,
  now: number,
): void {
  sql.exec(
    `UPDATE terminal_collection
     SET state = 'result_unknown',
         reason_code = 'gateway_disconnected',
         updated_at = ?
     WHERE gateway_id = ? AND state = 'collecting'`,
    now,
    gatewayId,
  );
}

export function openUnknownTerminalCollections(
  sql: SqlStorage,
  gatewayId: string,
): readonly TerminalCollectionRecord[] {
  return sql
    .exec<TerminalCollectionRow>(
      `SELECT gateway_id, source_key, request_id, payment_attempt_id,
              checkout_id, amount_minor, currency, payment_method, state,
              provider_payment_reference, tender_brand, provider_refundable,
              reason_code, expires_at, updated_at
       FROM terminal_collection
       WHERE gateway_id = ? AND state = 'result_unknown'`,
      gatewayId,
    )
    .toArray()
    .map(toRecord);
}

export function clearTerminalResultUnknown(
  sql: SqlStorage,
  gatewayId: string,
  sourceKey: string,
  paymentAttemptId: string,
  now: number,
): boolean {
  const existing = readTerminalCollection(sql, gatewayId, sourceKey);
  if (
    existing === null ||
    existing.paymentAttemptId !== paymentAttemptId ||
    existing.state !== "result_unknown"
  ) {
    return false;
  }
  sql.exec(
    `UPDATE terminal_collection
     SET state = 'declined',
         reason_code = 'operator_cleared_unknown',
         updated_at = ?
     WHERE gateway_id = ? AND source_key = ? AND payment_attempt_id = ?`,
    now,
    gatewayId,
    sourceKey,
    paymentAttemptId,
  );
  return true;
}

export function deleteGatewayTerminalCollections(
  sql: SqlStorage,
  gatewayId: string,
): void {
  sql.exec("DELETE FROM terminal_collection WHERE gateway_id = ?", gatewayId);
}

function toRecord(row: TerminalCollectionRow): TerminalCollectionRecord {
  return {
    gatewayId: row.gateway_id,
    sourceKey: row.source_key,
    requestId: row.request_id,
    paymentAttemptId: row.payment_attempt_id,
    checkoutId: row.checkout_id,
    amountMinor: row.amount_minor,
    currency: row.currency,
    paymentMethod: row.payment_method as TerminalPaymentMethod,
    state: row.state as TerminalCollectionState,
    providerPaymentReference: row.provider_payment_reference,
    tenderBrand: row.tender_brand,
    providerRefundable:
      row.provider_refundable === null ? null : row.provider_refundable === 1,
    reasonCode: row.reason_code,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  };
}
