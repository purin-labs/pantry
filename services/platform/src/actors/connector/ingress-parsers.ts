import type {
  CaseContent,
  ConnectorDelivery,
  ConnectorDeliveryReceipt,
  ConnectorIdentity,
  StoredMessageAttachment,
} from "@purin-labs/contracts";
import { parseStoredAttachmentList } from "../../messages/stored-attachment";
import type { Variant } from "@purin-labs/type-utils";
import {
  checked,
  connectorDeliveryReceiptSchema,
  connectorDeliveryRequestSchema,
  connectorDeliverySchema,
  connectorDeliveryStateSchema,
  connectorIngressRequestSchema,
  connectorIngressSchema,
  parseConnectorAddressWire,
} from "@purin-labs/contracts/connector-rpc";
import { parseJsonOrNull } from "@purin-labs/std";
import { invalid, parseIngressContent } from "./ingress-content";
import type {
  ConnectorDeliveryRequest,
  ConnectorDeliveryState,
  DeliveryRow,
  ConnectorIngressRecord,
  ConnectorIngressRequest,
  ConnectorResult,
  MetaRow,
} from "./types";

export function ensureConnectorIdentity(
  sql: SqlStorage,
  identity: ConnectorIdentity,
): ConnectorResult<null> {
  const current =
    sql
      .exec<MetaRow>(
        "SELECT organisation_id, connector_id FROM connector_meta WHERE singleton = 1",
      )
      .toArray()[0] ?? null;
  if (current === null) {
    sql.exec(
      "INSERT INTO connector_meta (singleton, organisation_id, connector_id) VALUES (1, ?, ?)",
      identity.organisationId,
      identity.connectorId,
    );
    return { ok: true, value: null };
  }
  return current.organisation_id === identity.organisationId &&
    current.connector_id === identity.connectorId
    ? { ok: true, value: null }
    : invalid("connector_identity_conflict");
}

export type ConnectorIngressContent = Variant<
  CaseContent,
  "user_message" | "record_message" | "text"
>;

export function parseIngressRequest(
  value: unknown,
): ConnectorIngressRequest | null {
  const request = checked(connectorIngressRequestSchema, value);
  if (request === null) return null;
  const ingress = parseIngress(request.ingress);
  if (
    ingress?.content.kind === "record_message" &&
    ingress.content.provenance.organisationId !==
      request.identity.organisationId
  )
    return null;
  const attachments = parseAttachments(request);
  return ingress === null || !attachments.ok
    ? null
    : {
        identity: {
          organisationId: request.identity.organisationId,
          connectorId: request.identity.connectorId,
        },
        ingress,
        attachments: attachments.value,
      };
}

export function parseIngress(value: unknown): ConnectorIngressRecord | null {
  const ingress = checked(connectorIngressSchema, value);
  if (ingress === null) return null;
  const content = parseIngressContent(ingress.content);
  const attachments = parseAttachments(ingress);
  return content === null || !attachments.ok
    ? null
    : {
        ingressId: ingress.ingressId,
        connectorId: ingress.connectorId,
        nativeEventId: ingress.nativeEventId,
        nativeCursor: ingress.nativeCursor,
        caseId: ingress.caseId,
        content,
        receivedAt: ingress.receivedAt,
        attachments: attachments.value,
      };
}

/** The stored attachments of a record; a record without the field has none. */
function parseAttachments(
  record: object,
): ReturnType<typeof parseStoredAttachmentList> {
  return "attachments" in record && record.attachments !== undefined
    ? parseStoredAttachmentList(record.attachments)
    : { ok: true, value: [] as readonly StoredMessageAttachment[] };
}

export function parseDeliveryRequest(
  value: unknown,
): ConnectorDeliveryRequest | null {
  const request = checked(connectorDeliveryRequestSchema, value);
  if (request === null) return null;
  const delivery = parseDelivery(request.delivery);
  return delivery === null
    ? null
    : {
        identity: {
          organisationId: request.identity.organisationId,
          connectorId: request.identity.connectorId,
        },
        delivery,
        requestedAt: request.requestedAt,
      };
}

export function parseDelivery(value: unknown): ConnectorDelivery | null {
  const delivery = checked(connectorDeliverySchema, value);
  if (delivery === null) return null;
  const content = parseIngressContent(delivery.content);
  const address = parseConnectorAddress(delivery.address);
  return content === null || address === null
    ? null
    : {
        deliveryId: delivery.deliveryId,
        bindingId: delivery.bindingId,
        address,
        caseId: delivery.caseId,
        caseRevision: delivery.caseRevision,
        content,
        idempotencyKey: delivery.idempotencyKey,
        addressedAt: delivery.addressedAt,
      };
}

function parseConnectorAddress(
  value: unknown,
): ConnectorDelivery["address"] | null {
  return parseConnectorAddressWire(value);
}

function parseReceipt(value: unknown): ConnectorDeliveryReceipt | null {
  const receipt = checked(connectorDeliveryReceiptSchema, value);
  return receipt === null
    ? null
    : {
        deliveryId: receipt.deliveryId,
        connectorId: receipt.connectorId,
        idempotencyKey: receipt.idempotencyKey,
        nativeReceiptId: receipt.nativeReceiptId,
        deliveredAt: receipt.deliveredAt,
      };
}

export function parseDeliveryState(
  value: string,
): ConnectorDeliveryState | null {
  const state = checked(connectorDeliveryStateSchema, parseJsonOrNull(value));
  if (state === null) return null;
  switch (state.kind) {
    case "sending":
      return {
        kind: "sending",
        attempt: state.attempt,
        leaseExpiresAt: state.leaseExpiresAt,
      };
    case "retryable":
      return {
        kind: "retryable",
        attempt: state.attempt,
        reason: state.reason,
        retryAt: state.retryAt,
      };
    case "delivered": {
      const receipt = parseReceipt(state.receipt);
      return receipt === null ? null : { kind: "delivered", receipt };
    }
    case "rejected":
      // Credential availability is recoverable; normalize older persisted failures.
      if (state.reason === "connector_credential_unavailable") {
        return {
          kind: "retryable",
          attempt: 1,
          reason: state.reason,
          retryAt: 0,
        };
      }
      return { kind: "rejected", reason: state.reason };
  }
}

/** A route read that started beside an admission which then refused. */
export function ignoreUnusedCredentialRoute(): void {}

export function parseDeliveryRows(rows: readonly DeliveryRow[]): {
  readonly deliveries: ConnectorDelivery[];
  readonly receipts: ConnectorDeliveryReceipt[];
} | null {
  const deliveries: ConnectorDelivery[] = [];
  const receipts: ConnectorDeliveryReceipt[] = [];
  for (const row of rows) {
    const delivery = parseDelivery(JSON.parse(row.payload));
    const state = parseDeliveryState(row.state_json);
    if (delivery === null || state === null) return null;
    deliveries.push(delivery);
    if (state.kind === "delivered") receipts.push(state.receipt);
  }
  return { deliveries, receipts };
}
