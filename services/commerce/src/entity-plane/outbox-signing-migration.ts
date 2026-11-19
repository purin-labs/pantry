import { createPublicKey, verify } from "node:crypto";
import { isRecord } from "@purin-labs/std";
import {
  parseCommerceDelivery,
  commerceDeliverySignaturePayload,
} from "@purin-labs/commerce-client";
import type { CommerceDatabase } from "../database.ts";
import type { CommerceSigner } from "../commerce-authority/contracts.ts";
import { rewindFeedConsumers } from "../feed-consumers.ts";

type MigrationRow = Readonly<{
  deliveryId: string;
  merchantId: string;
  merchantRevision: number;
  organisationId: string;
  deliveryJson: string;
  status: "pending" | "rejected";
}>;
type MigrationDelivery = Readonly<{
  deliveryId: string;
  outcome: "repaired" | "unchanged" | "quarantined";
}>;
export type OutboxSigningMigrationBatch =
  | Readonly<{
      kind: "complete";
      afterDeliveryId?: never;
      deliveries: readonly MigrationDelivery[];
    }>
  | Readonly<{
      kind: "continuation";
      afterDeliveryId: string;
      deliveries: readonly MigrationDelivery[];
    }>;

// This persistence migration verifies the original bytes before replacing a signature.
export function migrateOutboxSignatures(
  database: CommerceDatabase,
  signer: CommerceSigner,
  afterDeliveryId: string | null,
): OutboxSigningMigrationBatch {
  const rows = database
    .prepare(
      `SELECT outbox.delivery_id AS deliveryId, outbox.merchant_id AS merchantId,
       outbox.merchant_revision AS merchantRevision, merchant.external_reference AS organisationId,
       outbox.delivery_json AS deliveryJson, outbox.status
     FROM observation_outbox AS outbox JOIN merchant USING (merchant_id)
     WHERE (outbox.status = 'pending' OR (outbox.status = 'rejected' AND outbox.rejected_reason = 'underclerk_delivery_signature_invalid'))
       AND (? IS NULL OR outbox.delivery_id > ?)
     ORDER BY outbox.delivery_id LIMIT 100`,
    )
    .all<MigrationRow>(afterDeliveryId, afterDeliveryId);
  const deliveries: MigrationDelivery[] = [];
  for (const row of rows) {
    const outcome = migrateDelivery(database, signer, row);
    if (outcome === "quarantined" && row.status === "pending") {
      const retired = database
        .prepare(
          `UPDATE observation_outbox SET status = 'rejected', rejected_at = ?, rejected_reason = 'underclerk_delivery_signature_invalid'
         WHERE delivery_id = ? AND delivery_json = ? AND status = 'pending'`,
        )
        .run(new Date().toISOString(), row.deliveryId, row.deliveryJson);
      if (retired.changes !== 1)
        throw new Error(
          "Outbox changed while quarantining an unverified delivery",
        );
    }
    deliveries.push({ deliveryId: row.deliveryId, outcome });
  }
  const last = rows.at(-1);
  return rows.length === 100 && last !== undefined
    ? { kind: "continuation", afterDeliveryId: last.deliveryId, deliveries }
    : { kind: "complete", deliveries };
}

function migrateDelivery(
  database: CommerceDatabase,
  signer: CommerceSigner,
  row: MigrationRow,
): "repaired" | "unchanged" | "quarantined" {
  let repairedJson: string;
  try {
    const raw: unknown = JSON.parse(row.deliveryJson);
    if (!isRecord(raw) || !Array.isArray(raw.observations))
      return "quarantined";
    const delivery = parseCommerceDelivery(raw);
    if (
      delivery.deliveryId !== row.deliveryId ||
      delivery.merchantId !== row.merchantId ||
      // Version 1 also named its owner (Plan 80 step 2).
      (delivery.schemaVersion === "underclerk.commerce-delivery.v1" &&
        delivery.organisationId !== row.organisationId) ||
      delivery.merchantRevision !== row.merchantRevision ||
      delivery.signer.keyId !== signer.keyId
    )
      return "quarantined";
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: signer.publicKeyB64 },
      format: "jwk",
    });
    const signature = Buffer.from(delivery.signer.signature, "base64url");
    const original = commerceDeliverySignaturePayload({
      ...delivery,
      observations: raw.observations,
    });
    if (!verify(null, original, key, signature)) return "quarantined";
    const normalized = commerceDeliverySignaturePayload(delivery);
    if (verify(null, normalized, key, signature)) return "unchanged";
    const repaired = parseCommerceDelivery({
      ...delivery,
      signer: {
        keyId: signer.keyId,
        algorithm: "ed25519",
        signature: signer.sign(normalized),
      },
    });
    if (
      !verify(
        null,
        commerceDeliverySignaturePayload(repaired),
        key,
        Buffer.from(repaired.signer.signature, "base64url"),
      )
    )
      throw new Error(
        "Repaired outbox signature did not survive normalization",
      );
    repairedJson = JSON.stringify(repaired);
  } catch {
    return "quarantined";
  }
  const result = database
    .prepare(
      `UPDATE observation_outbox SET delivery_json = ?, status = 'pending', rejected_at = NULL, rejected_reason = NULL
     WHERE delivery_id = ? AND delivery_json = ? AND status = ?`,
    )
    .run(repairedJson, row.deliveryId, row.deliveryJson, row.status);
  if (result.changes !== 1)
    throw new Error("Outbox changed while migrating its signature");
  // A feed reader that already passed this delivery reads it again.
  rewindFeedConsumers(database, row.merchantId, row.merchantRevision);
  return "repaired";
}
