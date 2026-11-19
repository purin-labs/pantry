import type { OrganisationDatabase } from "../database-handles";
import type { OrganisationId } from "../ids";
import type { SupplierPayoutStateKind } from "@purin-labs/control-api";

/**
 * The canonical supplier payout.
 *
 * The lifecycle itself is not modelled here — its thirteen states and their
 * legal transitions are proven in the contract, and this store's job is only to
 * persist the current one without letting two writers disagree about it.
 *
 * Every write is a compare-and-set on the revision. A payout is the record of
 * money leaving the merchant, so the failure mode this prevents is not a lost
 * update but a lost *transition*: two concurrent writers each reading
 * `submitting` and each advancing it would settle a payout twice.
 */
export type SupplierPayoutRow = Readonly<{
  payoutId: string;
  payableId: string;
  supplierId: string;
  purchaseRequestId: string;
  rail: "gmo_aozora_private" | "wise_enterprise_payouts";
  integrationAccountId: string;
  destinationRevisionId: string;
  currency: string;
  recipientAmountMinor: number;
  feeCeilingMinor: number;
  idempotencyKey: string;
  stateKind: SupplierPayoutStateKind;
  /** Null only before approval, or after cancellation without one. */
  approvalDigest: string | null;
  payoutJson: string;
  revision: number;
}>;

/** States whose outcome is not yet known, and which therefore need an operator. */
const UNRESOLVED_STATES: readonly SupplierPayoutStateKind[] = [
  "submitting",
  "provider_action_required",
  "provider_pending",
  "return_pending",
  "reversal_pending",
  "indeterminate",
];

type SupplierPayoutWriteResult =
  | Readonly<{ ok: true; revision: number }>
  | Readonly<{
      ok: false;
      error: "revision_conflict" | "idempotency_conflict";
    }>;

/**
 * Create a payout at revision one.
 *
 * The idempotency key is unique per organisation, so a retried proposal cannot become
 * a second payout against the same payable. A conflict is reported rather than
 * silently adopted: the caller has to look at what already exists before
 * deciding that its own proposal is the same one.
 */
export async function createSupplierPayout(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    payout: SupplierPayoutRow;
    now: number;
  }>,
): Promise<SupplierPayoutWriteResult> {
  const { payout } = input;
  try {
    const inserted = await input.db
      .prepare(
        `INSERT INTO supplier_payout (
         organisation_id, payout_id, payable_id, supplier_id, purchase_request_id,
         rail, integration_account_id, destination_revision_id, currency,
         recipient_amount_minor, fee_ceiling_minor, idempotency_key,
         state_kind, approval_digest, payout_json, revision, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (organisation_id, payout_id) DO NOTHING`,
      )
      .bind(
        input.organisationId,
        payout.payoutId,
        payout.payableId,
        payout.supplierId,
        payout.purchaseRequestId,
        payout.rail,
        payout.integrationAccountId,
        payout.destinationRevisionId,
        payout.currency,
        payout.recipientAmountMinor,
        payout.feeCeilingMinor,
        payout.idempotencyKey,
        payout.stateKind,
        payout.approvalDigest,
        payout.payoutJson,
        input.now,
        input.now,
      )
      .run();
    return (inserted.meta?.changes ?? 0) > 0
      ? { ok: true, revision: 1 }
      : { ok: false, error: "idempotency_conflict" };
  } catch (cause) {
    // Only the idempotency constraint is an expected outcome here. Every other
    // constraint on this table — a negative amount, an unknown rail, a payout
    // past approval with no digest — is a caller defect, and reporting it as a
    // benign retry would file bad data under "already done".
    const existing = await readSupplierPayoutByIdempotencyKey(
      input.db,
      input.organisationId,
      payout.idempotencyKey,
    );
    if (existing === undefined) throw cause;
    return { ok: false, error: "idempotency_conflict" };
  }
}

/**
 * Advance a payout from an exact revision.
 *
 * The expected revision is the caller's evidence that it acted on the state it
 * read. Two writers racing to advance the same payout cannot both win.
 */
export async function advanceSupplierPayout(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    payoutId: string;
    expectedRevision: number;
    stateKind: SupplierPayoutStateKind;
    approvalDigest: string | null;
    payoutJson: string;
    now: number;
  }>,
): Promise<SupplierPayoutWriteResult> {
  const next = input.expectedRevision + 1;
  const updated = await input.db
    .prepare(
      `UPDATE supplier_payout
     SET state_kind = ?, approval_digest = ?, payout_json = ?,
         revision = ?, updated_at = ?
     WHERE organisation_id = ? AND payout_id = ? AND revision = ?`,
    )
    .bind(
      input.stateKind,
      input.approvalDigest,
      input.payoutJson,
      next,
      input.now,
      input.organisationId,
      input.payoutId,
      input.expectedRevision,
    )
    .run();
  return (updated.meta?.changes ?? 0) > 0
    ? { ok: true, revision: next }
    : { ok: false, error: "revision_conflict" };
}

export async function readSupplierPayout(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  payoutId: string,
): Promise<SupplierPayoutRow | undefined> {
  const row = await db
    .prepare(`${PAYOUT_SELECT} WHERE organisation_id = ? AND payout_id = ?`)
    .bind(organisationId, payoutId)
    .first<SupplierPayoutRow>();
  return row ?? undefined;
}

/**
 * The payout a request identity already produced, if any.
 *
 * Read before proposing, so a retry finds its own earlier payout rather than
 * creating a second one against the same payable.
 */
export async function readSupplierPayoutByIdempotencyKey(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  idempotencyKey: string,
): Promise<SupplierPayoutRow | undefined> {
  const row = await db
    .prepare(
      `${PAYOUT_SELECT} WHERE organisation_id = ? AND idempotency_key = ?`,
    )
    .bind(organisationId, idempotencyKey)
    .first<SupplierPayoutRow>();
  return row ?? undefined;
}

/**
 * Every payout whose outcome is not yet known.
 *
 * This is the operator's work queue and the recovery driver's input. Ordered
 * oldest first, because the payout that has been unresolved longest is the one
 * a supplier is most likely already asking about.
 */
export async function listUnresolvedSupplierPayouts(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<readonly SupplierPayoutRow[]> {
  const placeholders = UNRESOLVED_STATES.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `${PAYOUT_SELECT}
     WHERE organisation_id = ? AND state_kind IN (${placeholders})
     ORDER BY updated_at ASC`,
    )
    .bind(organisationId, ...UNRESOLVED_STATES)
    .all<SupplierPayoutRow>();
  return result.results ?? [];
}

/** Every payout for one supplier, newest activity first. */
export async function listSupplierPayoutsForSupplier(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  supplierId: string,
): Promise<readonly SupplierPayoutRow[]> {
  const result = await db
    .prepare(
      `${PAYOUT_SELECT}
     WHERE organisation_id = ? AND supplier_id = ?
     ORDER BY updated_at DESC`,
    )
    .bind(organisationId, supplierId)
    .all<SupplierPayoutRow>();
  return result.results ?? [];
}

/** The payouts that one timeline read returns. */
const MAX_DATED_PAYOUTS = 200;

type DatedSupplierPayout = SupplierPayoutRow &
  Readonly<{ createdAt: number; updatedAt: number }>;

/**
 * The payouts that were moving at any time in a window, newest first: each one
 * from when it was proposed to its last change. One row more than the limit
 * says that the window held more.
 */
export async function listSupplierPayoutsInWindow(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  window: Readonly<{ from: number; to: number }>,
): Promise<
  Readonly<{ payouts: readonly DatedSupplierPayout[]; truncated: boolean }>
> {
  const result = await db
    .prepare(
      `SELECT ${PAYOUT_COLUMNS}, created_at AS createdAt, updated_at AS updatedAt
     FROM supplier_payout
     WHERE organisation_id = ? AND created_at < ? AND updated_at >= ?
     ORDER BY created_at DESC, payout_id LIMIT ?`,
    )
    .bind(organisationId, window.to, window.from, MAX_DATED_PAYOUTS + 1)
    .all<DatedSupplierPayout>();
  return {
    payouts: result.results.slice(0, MAX_DATED_PAYOUTS),
    truncated: result.results.length > MAX_DATED_PAYOUTS,
  };
}

const PAYOUT_COLUMNS = `
         payout_id AS payoutId, payable_id AS payableId,
         supplier_id AS supplierId, purchase_request_id AS purchaseRequestId,
         rail, integration_account_id AS integrationAccountId,
         destination_revision_id AS destinationRevisionId, currency,
         recipient_amount_minor AS recipientAmountMinor,
         fee_ceiling_minor AS feeCeilingMinor,
         idempotency_key AS idempotencyKey, state_kind AS stateKind,
         approval_digest AS approvalDigest, payout_json AS payoutJson, revision`;

const PAYOUT_SELECT = `SELECT ${PAYOUT_COLUMNS} FROM supplier_payout`;

export async function listSupplierPayoutsForInquiry(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  now: number,
): Promise<readonly SupplierPayoutRow[]> {
  const rows = await db
    .prepare(
      `${PAYOUT_SELECT} WHERE organisation_id = ? AND next_inquiry_at <= ?
    AND state_kind IN ('submitting', 'provider_action_required', 'provider_pending', 'return_pending', 'reversal_pending', 'indeterminate', 'settled')
    ORDER BY next_inquiry_at, payout_id LIMIT 50`,
    )
    .bind(organisationId, now)
    .all<SupplierPayoutRow>();
  return rows.results;
}
