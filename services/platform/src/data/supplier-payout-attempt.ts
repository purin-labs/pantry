import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { PayoutAttemptStore } from "../payouts/executor";
import { PAYOUT_EVENT_ATTEMPT_MATCH } from "./supplier-payout-event-inbox";

/**
 * Durable evidence of what Pantry sent to a payout provider.
 *
 * The ordering this enforces is the whole point: the attempt row exists before
 * the request leaves, so a crash between dispatch and the provider's answer
 * still leaves something for recovery to find. Without it, an interrupted
 * payout is indistinguishable from one that never happened, and the safe
 * response to that ambiguity is the expensive one — never sending again.
 */
type SupplierPayoutAttemptRecord = Readonly<{
  payoutId: string;
  attemptId: string;
  approvalDigest: string;
  requestIdentity: string;
  /** Absent until the provider names a transfer. Absence is the evidence. */
  providerTransferId: string | null;
  fundingOperationId: string | null;
  dispatchedAt: number;
}>;

export function createSupplierPayoutAttemptStore(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    now: () => number;
  }>,
): PayoutAttemptStore {
  return {
    async recordDispatch(dispatch) {
      const at = input.now();
      // A recorded dispatch can only be inquired about; it cannot send again.
      const written = await input.db
        .prepare(
          `INSERT INTO supplier_payout_attempt (
           organisation_id, payout_id, attempt_id, approval_digest, request_identity,
           provider_transfer_id, funding_operation_id, dispatched_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)
         ON CONFLICT (organisation_id, attempt_id) DO NOTHING`,
        )
        .bind(
          input.organisationId,
          dispatch.payoutId,
          dispatch.attemptId,
          dispatch.approvalDigest,
          dispatch.requestIdentity,
          at,
          at,
        )
        .run();
      if ((written.meta.changes ?? 0) !== 1)
        throw new Error("payout_attempt_already_dispatched");
    },

    async recordFundingDispatch(funding) {
      // Write-once, and only onto the transfer it belongs to. Binding the
      // update to the transfer id stops a funding operation being attached to
      // an attempt that has since adopted a different transfer during recovery.
      const written = await input.db
        .prepare(
          `UPDATE supplier_payout_attempt AS a
         SET funding_operation_id = ?, updated_at = ?
         WHERE organisation_id = ? AND attempt_id = ? AND payout_id = ? AND provider_transfer_id = ?
           AND funding_operation_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM supplier_payout p
             JOIN supplier_payout_event e
               ON e.organisation_id = p.organisation_id
              AND e.rail = p.rail
              AND e.integration_account_id = p.integration_account_id
              AND ${PAYOUT_EVENT_ATTEMPT_MATCH}
             WHERE p.organisation_id = ? AND p.payout_id = ? AND e.status = 'conflict'
           )`,
        )
        .bind(
          funding.fundingOperationId,
          input.now(),
          input.organisationId,
          funding.attemptId,
          funding.payoutId,
          funding.providerTransferId,
          input.organisationId,
          funding.payoutId,
        )
        .run();
      if ((written.meta.changes ?? 0) !== 1)
        throw new Error("payout_funding_dispatch_conflict");
    },

    async recordProviderTransfer(transfer) {
      // Only ever fills an absent identity. A transfer id that is already
      // recorded is the one the provider gave us; overwriting it would lose
      // the reference recovery needs.
      const written = await input.db
        .prepare(
          `UPDATE supplier_payout_attempt
         SET provider_transfer_id = ?, updated_at = ?
         WHERE organisation_id = ? AND attempt_id = ? AND payout_id = ? AND provider_transfer_id IS NULL`,
        )
        .bind(
          transfer.providerTransferId,
          input.now(),
          input.organisationId,
          transfer.attemptId,
          transfer.payoutId,
        )
        .run();
      if ((written.meta.changes ?? 0) !== 1) {
        const existing = await readSupplierPayoutAttempt(
          input.db,
          input.organisationId,
          transfer.attemptId,
        );
        if (
          existing?.payoutId !== transfer.payoutId ||
          existing.providerTransferId !== transfer.providerTransferId
        ) {
          throw new Error("payout_transfer_identity_conflict");
        }
      }
    },
  };
}

/** Read one attempt, for recovery and operator readback. */
export async function readSupplierPayoutAttempt(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  attemptId: string,
): Promise<SupplierPayoutAttemptRecord | undefined> {
  const row = await db
    .prepare(
      `SELECT payout_id AS payoutId, attempt_id AS attemptId,
            approval_digest AS approvalDigest, request_identity AS requestIdentity,
            provider_transfer_id AS providerTransferId,
            funding_operation_id AS fundingOperationId,
            dispatched_at AS dispatchedAt
     FROM supplier_payout_attempt
     WHERE organisation_id = ? AND attempt_id = ?`,
    )
    .bind(organisationId, attemptId)
    .first<SupplierPayoutAttemptRecord>();
  return row ?? undefined;
}

/**
 * Every attempt Pantry has dispatched for one payout.
 *
 * More than one row means an earlier attempt went unresolved. That is a fact
 * worth surfacing rather than tidying away: it is exactly the shape of a payout
 * at risk of paying a supplier twice.
 */
export async function listSupplierPayoutAttempts(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  payoutId: string,
): Promise<readonly SupplierPayoutAttemptRecord[]> {
  const result = await db
    .prepare(
      `SELECT payout_id AS payoutId, attempt_id AS attemptId,
            approval_digest AS approvalDigest, request_identity AS requestIdentity,
            provider_transfer_id AS providerTransferId,
            funding_operation_id AS fundingOperationId,
            dispatched_at AS dispatchedAt
     FROM supplier_payout_attempt
     WHERE organisation_id = ? AND payout_id = ?
     ORDER BY dispatched_at ASC`,
    )
    .bind(organisationId, payoutId)
    .all<SupplierPayoutAttemptRecord>();
  return result.results ?? [];
}
