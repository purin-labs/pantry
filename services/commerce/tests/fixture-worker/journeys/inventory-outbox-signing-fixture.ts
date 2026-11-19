import { createPublicKey, verify } from "node:crypto";
import { isRecord } from "@purin-labs/std";
import {
  parseCommerceDelivery,
  commerceDeliverySignaturePayload,
} from "@purin-labs/commerce-client";
import { migrateOutboxSignatures } from "../../../src/entity-plane/outbox-signing-migration.ts";
import type { CommerceSigner } from "../../../src/commerce-authority/contracts.ts";
import type { CommerceDatabase } from "../../../src/database.ts";

export function verifyInventoryOutboxMigration(
  database: CommerceDatabase,
  merchantId: string,
  signer: CommerceSigner,
): unknown {
  const row = database
    .prepare(
      "SELECT delivery_json AS json FROM observation_outbox WHERE merchant_id = ? AND delivery_id LIKE 'entity_plane:%' ORDER BY merchant_revision DESC LIMIT 1",
    )
    .get<{ json: string }>(merchantId);
  if (row === undefined) throw new Error("Production delivery fixture missing");
  const delivery = parseCommerceDelivery(JSON.parse(row.json));
  const observation = delivery.observations[0];
  if (observation?.kind !== "commerce_list_entry_changed")
    throw new Error("Production observation missing");
  const oldOrder = {
    kind: observation.kind,
    observationId: observation.observationId,
    entry: observation.entry,
    entityRef: observation.entityRef,
    revision: observation.revision,
    merchantRevision: observation.merchantRevision,
  };
  const ids: string[] = [];
  for (const variant of [
    "pending",
    "signature",
    "tampered",
    "unrelated",
    "delivered",
  ]) {
    const raw = {
      schemaVersion: "underclerk.commerce-delivery.v2" as const,
      deliveryId: `${delivery.deliveryId}:fixture_${variant}`,
      merchantId: delivery.merchantId,
      merchantRevision: delivery.merchantRevision,
      observedAt: delivery.observedAt,
      observations: [oldOrder],
      signer: {
        keyId: signer.keyId,
        algorithm: "ed25519" as const,
        signature: "pending",
      },
    };
    raw.signer.signature = signer.sign(commerceDeliverySignaturePayload(raw));
    const encoded: unknown = JSON.parse(JSON.stringify(raw));
    if (!isRecord(encoded)) throw new Error("Outbox fixture invalid");
    if (variant === "tampered")
      encoded.observedAt = new Date(
        Date.parse(delivery.observedAt) + 1,
      ).toISOString();
    let status = "pending";
    let reason: string | null = null;
    if (variant === "delivered") status = "delivered";
    if (variant === "signature") {
      status = "rejected";
      reason = "underclerk_delivery_signature_invalid";
    }
    if (variant === "unrelated") {
      status = "rejected";
      reason = "underclerk_scope_mismatch";
    }
    database
      .prepare(
        "INSERT INTO observation_outbox (delivery_id, merchant_id, merchant_revision, delivery_json, status, created_at, rejected_at, rejected_reason, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        raw.deliveryId,
        merchantId,
        delivery.merchantRevision,
        JSON.stringify(encoded),
        status,
        delivery.observedAt,
        status === "rejected" ? delivery.observedAt : null,
        reason,
        status === "delivered" ? delivery.observedAt : null,
      );
    ids.push(raw.deliveryId);
  }
  let cursor: string | null = null;
  const outcomes: { deliveryId: string; outcome: string }[] = [];
  while (true) {
    const batch = migrateOutboxSignatures(database, signer, cursor);
    outcomes.push(...batch.deliveries);
    if (batch.kind === "complete") break;
    cursor = batch.afterDeliveryId;
  }
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: signer.publicKeyB64 },
    format: "jwk",
  });
  let verified = true;
  for (const id of ids.slice(0, 2)) {
    const stored = database
      .prepare(
        "SELECT delivery_json AS json, status, rejected_reason AS reason FROM observation_outbox WHERE delivery_id = ?",
      )
      .get<{ json: string; status: string; reason: string | null }>(id);
    if (stored === undefined) throw new Error("Repaired delivery missing");
    const repaired = parseCommerceDelivery(JSON.parse(stored.json));
    verified &&=
      stored.status === "pending" &&
      stored.reason === null &&
      verify(
        null,
        commerceDeliverySignaturePayload(repaired),
        key,
        Buffer.from(repaired.signer.signature, "base64url"),
      );
  }
  const tampered = database
    .prepare(
      "SELECT status, rejected_reason AS reason FROM observation_outbox WHERE delivery_id = ?",
    )
    .get<{ status: string; reason: string | null }>(
      `${delivery.deliveryId}:fixture_tampered`,
    );
  verified &&=
    tampered?.status === "rejected" &&
    tampered.reason === "underclerk_delivery_signature_invalid";
  const second = migrateOutboxSignatures(database, signer, null);
  return {
    repaired: outcomes.filter(repairedOutcome).length,
    quarantined: outcomes.filter(quarantinedOutcome).length,
    untouched: database
      .prepare(
        "SELECT COUNT(*) AS count FROM observation_outbox WHERE delivery_id IN (?, ?) AND status IN ('rejected', 'delivered')",
      )
      .get<{ count: number }>(
        `${delivery.deliveryId}:fixture_unrelated`,
        `${delivery.deliveryId}:fixture_delivered`,
      )?.count,
    verified,
    repeatedRepairs: second.deliveries.filter(repairedOutcome).length,
  };
}

function repairedOutcome(value: { outcome: string }): boolean {
  return value.outcome === "repaired";
}
function quarantinedOutcome(value: { outcome: string }): boolean {
  return value.outcome === "quarantined";
}
