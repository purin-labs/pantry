import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import {
  assertSupplierPayoutObservationWithLexicon,
  type SupplierPayoutObservation,
} from "../commerce-wasm";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { SupplierPayoutRail } from "./supplier-payout-certification";
import type { Variant } from "@purin-labs/type-utils";

type PayoutEvidenceContext = Readonly<{
  providerEventId: string;
  rail: SupplierPayoutRail;
  integrationAccountId: string;
  sourceReference: string;
  environment: "development" | "production";
  payloadDigest: string;
  amountMinor: number;
  currency: string;
  occurredAt: number;
  receivedAt: number;
  evidenceRef: string;
}>;

export type SupplierPayoutEvidence = PayoutEvidenceContext &
  (
    | Readonly<{
        targetKind: "transfer";
        targetId: string;
        observation: SupplierPayoutObservation;
      }>
    | Readonly<{
        targetKind: "request";
        targetId: string;
        observation: Variant<SupplierPayoutObservation, "failed">;
      }>
  );
export type SupplierPayoutEvent = SupplierPayoutEvidence &
  Readonly<{ status: "pending" | "applied" | "conflict" }>;

// Shared by reconciliation, audit and proposal fencing; aliases identify the
// event and durable attempt, respectively.
export const PAYOUT_EVENT_ATTEMPT_MATCH = `((e.target_kind = 'transfer' AND e.target_id = a.provider_transfer_id)
  OR (e.target_kind = 'request' AND e.target_id = a.request_identity))`;

type EventAdmission = Readonly<{
  outcome: "admitted" | "duplicate" | "conflict";
  event: SupplierPayoutEvent;
}>;

/** Called only by a trusted adapter after authenticating and normalizing provider evidence. */
export async function admitSupplierPayoutEvent(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    event: SupplierPayoutEvidence;
  }>,
): Promise<EventAdmission> {
  const event = parseEvent({
    ...input.event,
    observationJson: JSON.stringify(input.event.observation),
    status: "pending",
  });
  const inserted = await input.db
    .prepare(
      `INSERT INTO supplier_payout_event (
    organisation_id, provider_event_id, rail, integration_account_id, source_reference,
    environment, target_kind, target_id, payload_digest, amount_minor, currency, observation_json, occurred_at,
    received_at, evidence_ref, status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  ON CONFLICT DO NOTHING`,
    )
    .bind(
      input.organisationId,
      event.providerEventId,
      event.rail,
      event.integrationAccountId,
      event.sourceReference,
      event.environment,
      event.targetKind,
      event.targetId,
      event.payloadDigest,
      event.amountMinor,
      event.currency,
      JSON.stringify(event.observation),
      event.occurredAt,
      event.receivedAt,
      event.evidenceRef,
    )
    .run();
  const stored = await input.db
    .prepare(`${EVENT_SELECT} WHERE ${EVENT_KEY}`)
    .bind(...eventKey(input.organisationId, event))
    .first<Record<string, unknown>>();
  if (stored === null) throw new Error("supplier_payout_event_not_persisted");
  const original = parseEvent(stored);
  if (
    original.payloadDigest !== event.payloadDigest ||
    original.targetKind !== event.targetKind ||
    original.targetId !== event.targetId ||
    original.sourceReference !== event.sourceReference ||
    original.occurredAt !== event.occurredAt ||
    original.amountMinor !== event.amountMinor ||
    original.currency !== event.currency ||
    JSON.stringify(original.observation) !== JSON.stringify(event.observation)
  ) {
    await markPayoutEvent(input.db, input.organisationId, original, "conflict");
    return { outcome: "conflict", event: { ...original, status: "conflict" } };
  }
  return {
    outcome: (inserted.meta.changes ?? 0) > 0 ? "admitted" : "duplicate",
    event: original,
  };
}

export async function listUnappliedEvents(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<readonly SupplierPayoutEvent[]> {
  const rows = await db
    .prepare(
      `${EVENT_SELECT} e WHERE organisation_id = ? AND status = 'pending'
    ORDER BY EXISTS (SELECT 1 FROM supplier_payout p JOIN supplier_payout_attempt a
      ON a.organisation_id = p.organisation_id AND a.payout_id = p.payout_id
      WHERE p.organisation_id = e.organisation_id AND p.rail = e.rail AND p.integration_account_id = e.integration_account_id
        AND ${PAYOUT_EVENT_ATTEMPT_MATCH}) DESC, occurred_at, provider_event_id LIMIT 100`,
    )
    .bind(organisationId)
    .all<Record<string, unknown>>();
  return rows.results.map(parseEvent);
}

export async function markPayoutEvent(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  event: SupplierPayoutEvent,
  status: "applied" | "conflict",
): Promise<void> {
  await db
    .prepare(
      `UPDATE supplier_payout_event SET status = ? WHERE ${EVENT_KEY} AND (status = 'pending' OR ? = 'conflict')`,
    )
    .bind(status, ...eventKey(organisationId, event), status)
    .run();
}

export function eventKey(
  organisationId: OrganisationId,
  event: SupplierPayoutEvent,
): readonly string[] {
  return [
    organisationId,
    event.rail,
    event.integrationAccountId,
    event.environment,
    event.providerEventId,
  ];
}

export const EVENT_KEY =
  "organisation_id = ? AND rail = ? AND integration_account_id = ? AND environment = ? AND provider_event_id = ?";
const EVENT_SELECT = `SELECT rowid AS cursor, provider_event_id AS providerEventId, rail,
  integration_account_id AS integrationAccountId, source_reference AS sourceReference,
  environment, target_kind AS targetKind, target_id AS targetId, payload_digest AS payloadDigest,
  amount_minor AS amountMinor, currency, observation_json AS observationJson, occurred_at AS occurredAt, received_at AS receivedAt,
  evidence_ref AS evidenceRef, status FROM supplier_payout_event`;

function parseEvent(row: Record<string, unknown>): SupplierPayoutEvent {
  if (
    (row.rail !== "gmo_aozora_private" &&
      row.rail !== "wise_enterprise_payouts") ||
    (row.environment !== "development" && row.environment !== "production") ||
    (row.status !== "pending" &&
      row.status !== "applied" &&
      row.status !== "conflict")
  ) {
    throw new Error("supplier_payout_event_invalid");
  }
  const observation: unknown = JSON.parse(textField(row.observationJson));
  assertSupplierPayoutObservationWithLexicon(observation);
  const targetId = textField(row.targetId);
  if (row.targetKind !== "transfer" && row.targetKind !== "request")
    throw new Error("supplier_payout_event_target_invalid");
  if (
    row.targetKind === "transfer" &&
    "providerTransferId" in observation &&
    observation.providerTransferId !== targetId
  ) {
    throw new Error("supplier_payout_event_transfer_mismatch");
  }
  const payloadDigest = textField(row.payloadDigest);
  if (!/^[0-9a-f]{64}$/u.test(payloadDigest))
    throw new Error("supplier_payout_event_digest_invalid");
  const amountMinor = timeField(row.amountMinor);
  const currency = textField(row.currency);
  if (amountMinor === 0 || !/^[A-Z]{3}$/u.test(currency))
    throw new Error("supplier_payout_event_amount_invalid");
  const context = {
    amountMinor,
    currency,
    providerEventId: textField(row.providerEventId),
    rail: row.rail,
    integrationAccountId: textField(row.integrationAccountId),
    sourceReference: textField(row.sourceReference),
    environment: row.environment,
    payloadDigest,
    occurredAt: timeField(row.occurredAt),
    receivedAt: timeField(row.receivedAt),
    evidenceRef: textField(row.evidenceRef),
  } satisfies PayoutEvidenceContext;
  if (row.targetKind === "request") {
    if (observation.kind !== "failed")
      throw new Error("supplier_payout_request_evidence_invalid");
    return {
      ...context,
      targetKind: "request",
      targetId,
      observation,
      status: row.status,
    };
  }
  return {
    ...context,
    targetKind: "transfer",
    targetId,
    observation,
    status: row.status,
  };
}

function textField(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value !== value.trim()
  )
    throw new Error("supplier_payout_event_text_invalid");
  return value;
}
function timeField(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("supplier_payout_event_time_invalid");
  return value;
}

export async function readSupplierPayoutAuditEvents(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  payoutId: string,
  after: number,
) {
  const rows = await db
    .prepare(
      `${EVENT_SELECT} e
    WHERE organisation_id = ? AND rowid > ? AND EXISTS (
      SELECT 1 FROM supplier_payout p JOIN supplier_payout_attempt a
        ON a.organisation_id = p.organisation_id AND a.payout_id = p.payout_id
      WHERE p.organisation_id = e.organisation_id AND p.payout_id = ? AND p.rail = e.rail
        AND p.integration_account_id = e.integration_account_id AND ${PAYOUT_EVENT_ATTEMPT_MATCH}
    ) ORDER BY rowid LIMIT 101`,
    )
    .bind(organisationId, after, payoutId)
    .all<Record<string, unknown>>();
  const events = rows.results.slice(0, 100).map(auditEvent);
  return {
    events,
    nextCursor:
      rows.results.length > 100 ? (events.at(-1)?.cursor ?? null) : null,
  };
}

function auditEvent(row: Record<string, unknown>) {
  const event = parseEvent(row);
  return {
    cursor: timeField(row.cursor),
    providerEventId: event.providerEventId,
    rail: event.rail,
    integrationAccountId: event.integrationAccountId,
    environment: event.environment,
    targetKind: event.targetKind,
    targetId: event.targetId,
    payloadDigest: event.payloadDigest,
    amountMinor: event.amountMinor,
    currency: event.currency,
    observation: event.observation,
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
    status: event.status,
  };
}

export async function listSupplierPayoutExceptions(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  after: number,
) {
  const rows = await db
    .prepare(
      `${EVENT_SELECT}
    WHERE organisation_id = ? AND status = 'conflict' AND rowid > ? ORDER BY rowid LIMIT 101`,
    )
    .bind(organisationId, after)
    .all<Record<string, unknown>>();
  const events = rows.results.slice(0, 100).map(auditEvent);
  return {
    events,
    nextCursor:
      rows.results.length > 100 ? (events.at(-1)?.cursor ?? null) : null,
  };
}
