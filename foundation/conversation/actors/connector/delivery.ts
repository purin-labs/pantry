import type {
  ConnectorDelivery,
  ConnectorIdentity,
} from "@purin-labs/contracts";
import {
  inspectConnectorCaseWorkEfficiency,
  type CaseWorkOutcome,
  type ConnectorCaseWorkResult,
} from "../connector-case-work";
import { parseJsonOrNull } from "@purin-labs/std";
import type { DeliveryChannel } from "./channel-adapter";
import {
  ensureConnectorIdentity,
  parseDelivery,
  parseDeliveryState,
  parseDeliveryRows,
  parseIngress,
} from "./ingress-parsers";
import { count, invalid } from "./support";
import {
  type ConnectorDeliveryClaim,
  type ConnectorDeliveryRequest,
  type ConnectorDeliveryResult,
  type ConnectorDeliveryState,
  type ConnectorIngressRecord,
  type ConnectorIngressRequest,
  type ConnectorResult,
  type ConnectorSnapshot,
  DELIVERY_LEASE_MS,
  type DeliveryRow,
  type JsonRow,
  type MetaRow,
} from "./types";

/** The identity of this Connector. It throws when the Connector has none. */
export function readConnectorIdentity(sql: SqlStorage): ConnectorIdentity {
  const row = sql
    .exec<MetaRow>(
      "SELECT organisation_id, connector_id FROM connector_meta WHERE singleton = 1",
    )
    .toArray()[0];
  if (row === undefined) throw new Error("connector_identity_missing");
  return { organisationId: row.organisation_id, connectorId: row.connector_id };
}

export function caseWorkResult(
  result: CaseWorkOutcome,
): ConnectorCaseWorkResult {
  switch (result.kind) {
    case "completed":
      return { kind: "completed", completedAt: Date.now() };
    case "retry":
      return { kind: "retry", reason: result.reason, retryAt: result.retryAt };
    case "rejected":
      return {
        kind: "rejected",
        reason: result.reason,
        rejectedAt: Date.now(),
      };
  }
}

export function createConnectorSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), organisation_id TEXT NOT NULL, connector_id TEXT NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_ingress (
    ingress_id TEXT PRIMARY KEY, native_event_id TEXT NOT NULL UNIQUE,
    payload TEXT NOT NULL CHECK (json_valid(payload))
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_delivery (
    delivery_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    state_json TEXT NOT NULL CHECK (json_valid(state_json))
  )`);
}

export function acceptIngress(
  sql: SqlStorage,
  input: ConnectorIngressRequest,
): ConnectorResult<{
  readonly kind: "accepted" | "duplicate";
  readonly caseId: string;
}> {
  const identity = ensureConnectorIdentity(sql, input.identity);
  if (!identity.ok) return identity;
  if (input.ingress.connectorId !== input.identity.connectorId)
    return invalid("connector_identity_mismatch");
  const ingress = {
    ...input.ingress,
    attachments: input.attachments,
  } satisfies ConnectorIngressRecord;
  const payload = JSON.stringify(ingress);
  const existing =
    sql
      .exec<JsonRow>(
        "SELECT payload FROM connector_ingress WHERE ingress_id = ? OR native_event_id = ?",
        input.ingress.ingressId,
        input.ingress.nativeEventId,
      )
      .toArray()[0] ?? null;
  if (existing !== null) {
    const parsed = parseIngress(JSON.parse(existing.payload));
    return parsed !== null && JSON.stringify(parsed) === payload
      ? { ok: true, value: { kind: "duplicate", caseId: parsed.caseId } }
      : invalid("connector_ingress_conflict");
  }
  sql.exec(
    "INSERT INTO connector_ingress (ingress_id, native_event_id, payload) VALUES (?, ?, ?)",
    input.ingress.ingressId,
    input.ingress.nativeEventId,
    payload,
  );
  return {
    ok: true,
    value: { kind: "accepted", caseId: input.ingress.caseId },
  };
}

export function claimDelivery(
  sql: SqlStorage,
  input: ConnectorDeliveryRequest,
): ConnectorResult<ConnectorDeliveryClaim> {
  const identity = ensureConnectorIdentity(sql, input.identity);
  if (!identity.ok) return identity;
  const payload = JSON.stringify(input.delivery);
  const existing =
    sql
      .exec<DeliveryRow>(
        "SELECT payload, state_json FROM connector_delivery WHERE delivery_id = ? OR idempotency_key = ?",
        input.delivery.deliveryId,
        input.delivery.idempotencyKey,
      )
      .toArray()[0] ?? null;
  if (existing !== null) {
    const storedDelivery = parseDelivery(parseJsonOrNull(existing.payload));
    if (storedDelivery === null) return invalid("connector_storage_corrupt");
    if (!sameDeliveryIntent(storedDelivery, input.delivery)) {
      return invalid("connector_delivery_conflict");
    }
    const state = parseDeliveryState(existing.state_json);
    if (state === null) return invalid("connector_storage_corrupt");
    if (state.kind === "delivered") {
      return {
        ok: true,
        value: { kind: "already_delivered", receipt: state.receipt },
      };
    }
    if (state.kind === "rejected") return { ok: true, value: state };
    if (state.kind === "sending" && state.leaseExpiresAt > input.requestedAt) {
      return {
        ok: true,
        value: {
          kind: "retry",
          reason: "connector_delivery_in_flight",
          retryAt: state.leaseExpiresAt,
        },
      };
    }
    if (state.kind === "retryable" && state.retryAt > input.requestedAt) {
      return {
        ok: true,
        value: { kind: "retry", reason: state.reason, retryAt: state.retryAt },
      };
    }
    const attempt = state.attempt + 1;
    const sending: ConnectorDeliveryState = {
      kind: "sending",
      attempt,
      leaseExpiresAt: input.requestedAt + DELIVERY_LEASE_MS,
    };
    sql.exec(
      "UPDATE connector_delivery SET state_json = ? WHERE delivery_id = ?",
      JSON.stringify(sending),
      input.delivery.deliveryId,
    );
    return {
      ok: true,
      value: { kind: "claimed", attempt, delivery: storedDelivery },
    };
  }
  const state: ConnectorDeliveryState = {
    kind: "sending",
    attempt: 1,
    leaseExpiresAt: input.requestedAt + DELIVERY_LEASE_MS,
  };
  sql.exec(
    `INSERT INTO connector_delivery (delivery_id, idempotency_key, payload, state_json) VALUES (?, ?, ?, ?)`,
    input.delivery.deliveryId,
    input.delivery.idempotencyKey,
    payload,
    JSON.stringify(state),
  );
  return {
    ok: true,
    value: { kind: "claimed", attempt: 1, delivery: input.delivery },
  };
}

// A retried queue message can have a new addressing time; the stored delivery
// remains authoritative for sending and finalizing its original receipt.
function sameDeliveryIntent(
  stored: ConnectorDelivery,
  incoming: ConnectorDelivery,
): boolean {
  return (
    stored.deliveryId === incoming.deliveryId &&
    stored.bindingId === incoming.bindingId &&
    stored.caseId === incoming.caseId &&
    stored.caseRevision === incoming.caseRevision &&
    stored.idempotencyKey === incoming.idempotencyKey &&
    JSON.stringify(stored.address) === JSON.stringify(incoming.address) &&
    JSON.stringify(stored.content) === JSON.stringify(incoming.content)
  );
}

export function finalizeDelivery(
  sql: SqlStorage,
  input: ConnectorDeliveryRequest,
  attempt: number,
  result: ConnectorDeliveryResult,
  channel: DeliveryChannel<unknown>,
): ConnectorResult<ConnectorDeliveryResult> {
  const row =
    sql
      .exec<DeliveryRow>(
        "SELECT payload, state_json FROM connector_delivery WHERE delivery_id = ?",
        input.delivery.deliveryId,
      )
      .toArray()[0] ?? null;
  const state = row === null ? null : parseDeliveryState(row.state_json);
  if (
    row === null ||
    row.payload !== JSON.stringify(input.delivery) ||
    state?.kind !== "sending" ||
    state.attempt !== attempt
  ) {
    return invalid("connector_delivery_claim_lost");
  }
  switch (result.kind) {
    case "delivered": {
      channel.delivered(sql, input.delivery, result.receipt);
      const delivered: ConnectorDeliveryState = {
        kind: "delivered",
        receipt: result.receipt,
      };
      sql.exec(
        "UPDATE connector_delivery SET state_json = ? WHERE delivery_id = ?",
        JSON.stringify(delivered),
        input.delivery.deliveryId,
      );
      return { ok: true, value: result };
    }
    case "retry": {
      const retryable: ConnectorDeliveryState = {
        kind: "retryable",
        attempt,
        reason: result.reason,
        retryAt: result.retryAt,
      };
      sql.exec(
        "UPDATE connector_delivery SET state_json = ? WHERE delivery_id = ?",
        JSON.stringify(retryable),
        input.delivery.deliveryId,
      );
      return { ok: true, value: result };
    }
    case "rejected":
      sql.exec(
        "UPDATE connector_delivery SET state_json = ? WHERE delivery_id = ?",
        JSON.stringify(result),
        input.delivery.deliveryId,
      );
      return { ok: true, value: result };
    case "already_delivered":
      return invalid("connector_delivery_result_invalid");
  }
}

export function inspectConnector(
  sql: SqlStorage,
): ConnectorResult<ConnectorSnapshot> {
  const meta =
    sql
      .exec<MetaRow>(
        "SELECT organisation_id, connector_id FROM connector_meta WHERE singleton = 1",
      )
      .toArray()[0] ?? null;
  if (meta === null) return invalid("connector_missing");
  const ingresses = parseIngressRows(
    sql
      .exec<JsonRow>("SELECT payload FROM connector_ingress ORDER BY rowid")
      .toArray(),
  );
  if (ingresses === null) return invalid("connector_storage_corrupt");
  const deliveryRows = sql
    .exec<DeliveryRow>(
      "SELECT payload, state_json FROM connector_delivery ORDER BY rowid",
    )
    .toArray();
  const deliveries = parseDeliveryRows(deliveryRows);
  if (deliveries === null) return invalid("connector_storage_corrupt");
  return {
    ok: true,
    value: {
      identity: {
        organisationId: meta.organisation_id,
        connectorId: meta.connector_id,
      },
      ingressCount: count(sql, "connector_ingress"),
      deliveryCount: count(sql, "connector_delivery"),
      caseWork: inspectConnectorCaseWorkEfficiency(sql),
      ingresses,
      deliveries: deliveries.deliveries,
      receipts: deliveries.receipts,
    },
  };
}

function parseIngressRows(
  rows: readonly JsonRow[],
): ConnectorIngressRecord[] | null {
  const ingresses: ConnectorIngressRecord[] = [];
  for (const row of rows) {
    const ingress = parseIngress(JSON.parse(row.payload));
    if (ingress === null) return null;
    ingresses.push(ingress);
  }
  return ingresses;
}
