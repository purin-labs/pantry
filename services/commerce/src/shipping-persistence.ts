import {
  parseShipmentLabelRate,
  type CommerceShipmentLabelAttemptV1,
} from "@purin-labs/commerce-client";
import type { ShipmentLabelRateSnapshot } from "@purin-labs/commerce-contracts";

import type { CommerceDatabase } from "./database.ts";

type RateRow = Readonly<{ rateJson: string }>;
type DigestRow = Readonly<{ commandDigest: string; rateJson: string }>;

export function writeShipmentLabelRate(
  database: CommerceDatabase,
  merchantId: string,
  rate: ShipmentLabelRateSnapshot,
  idempotencyKey: string,
  commandDigest: string,
  createdAt: string,
): void {
  database
    .prepare(
      `INSERT INTO shipment_label_rate (
       merchant_id, label_rate_id, shipment_id, shipment_revision,
       idempotency_key, command_digest, rate_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      merchantId,
      rate.labelRateId,
      rate.shipmentId,
      rate.shipmentRevision,
      idempotencyKey,
      commandDigest,
      JSON.stringify(rate),
      createdAt,
    );
}

export function readShipmentLabelRate(
  database: CommerceDatabase,
  merchantId: string,
  labelRateId: string,
): ShipmentLabelRateSnapshot | undefined {
  const row = database
    .prepare(
      "SELECT rate_json AS rateJson FROM shipment_label_rate WHERE merchant_id = ? AND label_rate_id = ?",
    )
    .get<RateRow>(merchantId, labelRateId);
  return row === undefined
    ? undefined
    : parseShipmentLabelRate(requireJson(row.rateJson));
}

export function readShipmentLabelRateByIdempotency(
  database: CommerceDatabase,
  merchantId: string,
  idempotencyKey: string,
):
  | Readonly<{ commandDigest: string; rate: ShipmentLabelRateSnapshot }>
  | undefined {
  const row = database
    .prepare(
      "SELECT command_digest AS commandDigest, rate_json AS rateJson FROM shipment_label_rate WHERE merchant_id = ? AND idempotency_key = ?",
    )
    .get<DigestRow>(merchantId, idempotencyKey);
  return row === undefined
    ? undefined
    : {
        commandDigest: row.commandDigest,
        rate: parseShipmentLabelRate(requireJson(row.rateJson)),
      };
}

export function writeShipmentLabelAttempt(
  database: CommerceDatabase,
  merchantId: string,
  attempt: CommerceShipmentLabelAttemptV1,
  commandDigest: string,
  createdAt: string,
): void {
  database
    .prepare(
      `INSERT INTO shipment_label_attempt (
       merchant_id, label_attempt_id, shipment_id, shipment_revision,
       label_rate_id, idempotency_key, command_digest, attempt_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      merchantId,
      attempt.labelAttemptId,
      attempt.shipmentId,
      attempt.shipmentRevision,
      attempt.labelRateId,
      attempt.idempotencyKey,
      commandDigest,
      JSON.stringify(attempt),
      createdAt,
    );
}

function requireJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Stored shipment operation JSON is invalid");
  }
}
