import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { reconcileSupplierPayoutWithLexicon } from "../commerce/commerce-wasm";
import { readOrganisationEnvironment } from "@purin-labs/agent/control/organisation-runtime";
import {
  EVENT_KEY,
  eventKey,
  listUnappliedEvents,
  markPayoutEvent,
  type SupplierPayoutEvent,
} from "../data/supplier-payout-event-inbox";
import { readSupplierPayable } from "../data/supplier-payable-store";
import {
  payoutSourceReference,
  readSealedPayoutPlan,
} from "../data/supplier-payout-plan";
import { readSupplierPayout } from "../data/supplier-payout-store";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { isRecord } from "@purin-labs/std";

type PayoutEventResult = "applied" | "waiting" | "conflict" | "retry";

export async function reconcilePayoutInbox(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  now: number,
): Promise<readonly PayoutEventResult[]> {
  const events = await listUnappliedEvents(db, organisationId);
  const results: PayoutEventResult[] = [];
  for (const event of events)
    results.push(await reconcilePayoutEvent(db, organisationId, event, now));
  return results;
}

async function reconcilePayoutEvent(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  event: SupplierPayoutEvent,
  now: number,
): Promise<PayoutEventResult> {
  const matches = await db
    .prepare(
      `SELECT DISTINCT p.payout_id AS payoutId, a.attempt_id AS attemptId, a.provider_transfer_id AS providerTransferId,
    a.funding_operation_id AS fundingOperationId, a.approval_digest AS approvalDigest, a.request_identity AS requestIdentity
    FROM supplier_payout p JOIN supplier_payout_attempt a
      ON a.organisation_id = p.organisation_id AND a.payout_id = p.payout_id
    WHERE p.organisation_id = ? AND p.rail = ? AND p.integration_account_id = ? AND ((? = 'transfer' AND a.provider_transfer_id = ?) OR (? = 'request' AND a.request_identity = ?))
    LIMIT 2`,
    )
    .bind(
      organisationId,
      event.rail,
      event.integrationAccountId,
      event.targetKind,
      event.targetId,
      event.targetKind,
      event.targetId,
    )
    .all<{
      payoutId: string;
      attemptId: string;
      providerTransferId: string | null;
      fundingOperationId: string | null;
      approvalDigest: string;
      requestIdentity: string;
    }>();
  const match = matches.results[0];
  if (match === undefined) return "waiting";
  if (matches.results.length !== 1) return conflict(db, organisationId, event);
  const payout = await readSupplierPayout(db, organisationId, match.payoutId);
  if (payout === undefined) return "waiting";
  const plan = readSealedPayoutPlan(payout, organisationId);
  const environment = await readOrganisationEnvironment(db, organisationId);
  if (
    plan === null ||
    payoutSourceReference(plan) !== event.sourceReference ||
    environment !== event.environment ||
    payout.recipientAmountMinor !== event.amountMinor ||
    payout.currency !== event.currency
  )
    return conflict(db, organisationId, event);
  if (
    match.approvalDigest !== plan.seal.approvalDigest ||
    match.requestIdentity !== plan.seal.idempotencyKey ||
    (event.targetKind === "request" &&
      (match.providerTransferId !== null || match.fundingOperationId !== null))
  )
    return conflict(db, organisationId, event);
  const payable = await readSupplierPayable(
    db,
    organisationId,
    payout.payableId,
  );
  if (
    payable === undefined ||
    payable.merchantId !== plan.subject.merchantId ||
    payable.supplierId !== payout.supplierId ||
    payable.purchaseRequestId !== payout.purchaseRequestId
  )
    return conflict(db, organisationId, event);
  const document: unknown = JSON.parse(payout.payoutJson);
  if (!isRecord(document)) return conflict(db, organisationId, event);
  if (contradictoryTerminalEvidence(payout.stateKind, event.observation.kind))
    return conflict(db, organisationId, event);
  const previousAt =
    typeof document.lastObservationAt === "number"
      ? document.lastObservationAt
      : -1;
  if (
    event.occurredAt < previousAt ||
    event.observation.kind === payout.stateKind
  ) {
    // A late earlier event is retained without regressing current provider evidence.
    await markPayoutEvent(db, organisationId, event, "applied");
    return "applied";
  }
  if (event.occurredAt === previousAt)
    return conflict(db, organisationId, event);
  const projected: unknown = JSON.parse(payable.payableJson);
  if (
    !isRecord(projected) ||
    !isRecord(projected.allocation) ||
    !isRecord(projected.grossAmount) ||
    projected.grossAmount.amountMinor !== payable.grossAmountMinor ||
    projected.grossAmount.currency !== payable.currency ||
    payable.currency !== payout.currency ||
    !isRecord(projected.allocation.inFlight) ||
    !isRecord(projected.allocation.settled) ||
    projected.payableId !== payable.payableId ||
    projected.organisationId !== organisationId ||
    projected.merchantId !== payable.merchantId ||
    projected.supplierId !== payable.supplierId ||
    projected.purchaseRequestId !== payable.purchaseRequestId ||
    projected.revision !== payable.revision ||
    projected.lifecycle !== payable.lifecycle ||
    projected.allocation.inFlight.amountMinor !== payable.inFlightMinor ||
    projected.allocation.settled.amountMinor !== payable.settledMinor
  )
    return conflict(db, organisationId, event);
  const reduced = reconcileSupplierPayoutWithLexicon({
    fromKind: payout.stateKind,
    observation: event.observation,
    payable: projected,
    amount: {
      amountMinor: payout.recipientAmountMinor,
      currency: payout.currency,
    },
  });
  if (!reduced.ok) return conflict(db, organisationId, event);
  const next = reduced.value;
  const revision = payout.revision + 1;
  const marker = JSON.stringify(eventKey(organisationId, event));
  const nextJson = JSON.stringify({
    plan,
    approval: document.approval,
    state: next.state,
    lastObservationAt: event.occurredAt,
    lastObservationId: marker,
    evidenceRef: event.evidenceRef,
  });
  // The first CAS fences both resources. D1 executes the batch atomically; the
  // marker makes dependent writes impossible when a concurrent payout wins.
  const results = await db.batch([
    db
      .prepare(
        `UPDATE supplier_payout SET state_kind = ?, payout_json = ?, revision = ?, updated_at = ?
      WHERE organisation_id = ? AND payout_id = ? AND revision = ?
      AND EXISTS (SELECT 1 FROM supplier_payable WHERE organisation_id = ? AND payable_id = ? AND revision = ?)
      AND EXISTS (SELECT 1 FROM supplier_payout_event WHERE ${EVENT_KEY} AND status = 'pending')
      AND EXISTS (SELECT 1 FROM supplier_payout_attempt WHERE organisation_id = ? AND attempt_id = ?
        AND (? = 'transfer' OR (provider_transfer_id IS NULL AND funding_operation_id IS NULL)))`,
      )
      .bind(
        next.state.kind,
        nextJson,
        revision,
        now,
        organisationId,
        payout.payoutId,
        payout.revision,
        organisationId,
        payable.payableId,
        payable.revision,
        ...eventKey(organisationId, event),
        organisationId,
        match.attemptId,
        event.targetKind,
      ),
    db
      .prepare(
        `UPDATE supplier_payable SET in_flight_minor = ?, settled_minor = ?, lifecycle = ?,
      revision = ?, payable_json = ?, updated_at = ? WHERE organisation_id = ? AND payable_id = ? AND revision = ?
      AND EXISTS (SELECT 1 FROM supplier_payout WHERE organisation_id = ? AND payout_id = ? AND revision = ?
        AND json_extract(payout_json, '$.lastObservationId') = ?)
      AND EXISTS (SELECT 1 FROM supplier_payout_event WHERE ${EVENT_KEY} AND status = 'pending')`,
      )
      .bind(
        next.payable.allocation.inFlight.amountMinor,
        next.payable.allocation.settled.amountMinor,
        next.payable.lifecycle,
        next.payable.revision,
        JSON.stringify(next.payable),
        now,
        organisationId,
        payable.payableId,
        payable.revision,
        organisationId,
        payout.payoutId,
        revision,
        marker,
        ...eventKey(organisationId, event),
      ),
    db
      .prepare(
        `UPDATE supplier_payout_event SET status = 'applied' WHERE ${EVENT_KEY} AND status = 'pending'
      AND EXISTS (SELECT 1 FROM supplier_payout WHERE organisation_id = ? AND payout_id = ? AND revision = ?
        AND json_extract(payout_json, '$.lastObservationId') = ?)`,
      )
      .bind(
        ...eventKey(organisationId, event),
        organisationId,
        payout.payoutId,
        revision,
        marker,
      ),
  ]);
  return (results[0]?.meta.changes ?? 0) > 0 ? "applied" : "retry";
}

async function conflict(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  event: SupplierPayoutEvent,
): Promise<"conflict"> {
  await markPayoutEvent(db, organisationId, event, "conflict");
  return "conflict";
}

function contradictoryTerminalEvidence(
  current: string,
  incoming: string,
): boolean {
  const currentFailed = current === "failed" || current === "cancelled";
  const incomingFailed = incoming === "failed" || incoming === "cancelled";
  const currentDelivered = [
    "settled",
    "return_pending",
    "returned",
    "reversal_pending",
    "reversed",
  ].includes(current);
  const incomingDelivered = [
    "settled",
    "return_pending",
    "returned",
    "reversal_pending",
    "reversed",
  ].includes(incoming);
  return (
    (currentFailed && incomingDelivered) || (incomingFailed && currentDelivered)
  );
}
