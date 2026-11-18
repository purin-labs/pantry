import type { OrganisationDatabase } from "../database-handles";
import type { OrganisationId } from "../ids";

/**
 * Persistence for what a supplier is owed and where they are paid.
 *
 * Two invariants live in the schema rather than here, because they are the ones
 * that cost real money if a caller forgets them: committed money can never
 * exceed what is owed, and the person who wrote a supplier's bank details can
 * never be the one who activates them.
 */

export type SupplierPayableRow = Readonly<{
  payableId: string;
  merchantId: string;
  supplierId: string;
  purchaseRequestId: string;
  currency: string;
  grossAmountMinor: number;
  inFlightMinor: number;
  settledMinor: number;
  lifecycle: string;
  revision: number;
  payableJson: string;
}>;

/**
 * Write a payable at an exact revision.
 *
 * The revision is a compare-and-set: two concurrent payouts allocating against
 * the same payable cannot both win, which is what stops a supplier being
 * committed twice for one invoice.
 */
export async function writeSupplierPayable(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    payable: SupplierPayableRow;
    expectedRevision: number | null;
    now: number;
  }>,
): Promise<boolean> {
  const { payable } = input;
  if (input.expectedRevision === null) {
    const inserted = await input.db
      .prepare(
        `INSERT INTO supplier_payable (
         organisation_id, payable_id, merchant_id, supplier_id, purchase_request_id,
         currency, gross_amount_minor, in_flight_minor, settled_minor,
         lifecycle, revision, payable_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (organisation_id, payable_id) DO NOTHING`,
      )
      .bind(
        input.organisationId,
        payable.payableId,
        payable.merchantId,
        payable.supplierId,
        payable.purchaseRequestId,
        payable.currency,
        payable.grossAmountMinor,
        payable.inFlightMinor,
        payable.settledMinor,
        payable.lifecycle,
        payable.revision,
        payable.payableJson,
        input.now,
      )
      .run();
    return (inserted.meta?.changes ?? 0) > 0;
  }
  const updated = await input.db
    .prepare(
      `UPDATE supplier_payable
     SET in_flight_minor = ?, settled_minor = ?, lifecycle = ?, revision = ?,
         payable_json = ?, updated_at = ?
     WHERE organisation_id = ? AND payable_id = ? AND revision = ?`,
    )
    .bind(
      payable.inFlightMinor,
      payable.settledMinor,
      payable.lifecycle,
      payable.revision,
      payable.payableJson,
      input.now,
      input.organisationId,
      payable.payableId,
      input.expectedRevision,
    )
    .run();
  return (updated.meta?.changes ?? 0) > 0;
}

export async function readSupplierPayable(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  payableId: string,
): Promise<SupplierPayableRow | undefined> {
  const row = await db
    .prepare(
      `SELECT payable_id AS payableId, merchant_id AS merchantId,
            supplier_id AS supplierId, purchase_request_id AS purchaseRequestId,
            currency, gross_amount_minor AS grossAmountMinor,
            in_flight_minor AS inFlightMinor, settled_minor AS settledMinor,
            lifecycle, revision, payable_json AS payableJson
     FROM supplier_payable
     WHERE organisation_id = ? AND payable_id = ?`,
    )
    .bind(organisationId, payableId)
    .first<SupplierPayableRow>();
  return row ?? undefined;
}

export type SupplierDestinationRow = Readonly<{
  revisionId: string;
  destinationId: string;
  supplierId: string;
  rail: string;
  maskedSummary: string;
  configurationRef: string;
  state: string;
  proposedBy: string | null;
  activatedBy: string | null;
  revision: number;
  destinationJson: string;
}>;

/**
 * Record a destination revision.
 *
 * Revisions are immutable once written, so this only ever inserts. Editing bank
 * details is a new revision by construction, which is what lets an approved
 * payout hold a revision id and be certain the account cannot change under it.
 */
export async function writeSupplierDestinationRevision(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    destination: SupplierDestinationRow;
    now: number;
  }>,
): Promise<boolean> {
  const { destination } = input;
  const inserted = await input.db
    .prepare(
      `INSERT INTO supplier_destination_revision (
       organisation_id, revision_id, destination_id, supplier_id, rail,
       masked_summary, configuration_ref, state, proposed_by, activated_by,
       revision, destination_json, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (organisation_id, revision_id) DO UPDATE SET
       state = excluded.state,
       activated_by = excluded.activated_by,
       destination_json = excluded.destination_json,
       updated_at = excluded.updated_at`,
    )
    .bind(
      input.organisationId,
      destination.revisionId,
      destination.destinationId,
      destination.supplierId,
      destination.rail,
      destination.maskedSummary,
      destination.configurationRef,
      destination.state,
      destination.proposedBy,
      destination.activatedBy,
      destination.revision,
      destination.destinationJson,
      input.now,
    )
    .run();
  return (inserted.meta?.changes ?? 0) > 0;
}

/** The account a supplier is currently paid to, if one is active. */
export async function readActiveSupplierDestination(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  destinationId: string,
): Promise<SupplierDestinationRow | undefined> {
  const row = await db
    .prepare(
      `${DESTINATION_SELECT} WHERE organisation_id = ? AND destination_id = ? AND state = 'active'`,
    )
    .bind(organisationId, destinationId)
    .first<SupplierDestinationRow>();
  return row ?? undefined;
}

/**
 * One exact revision, active or not.
 *
 * A payout reads the revision it was approved against, never whatever is active
 * now — otherwise retiring an account would re-point an approved payout.
 */
export async function readSupplierDestinationRevision(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  revisionId: string,
): Promise<SupplierDestinationRow | undefined> {
  const row = await db
    .prepare(
      `${DESTINATION_SELECT} WHERE organisation_id = ? AND revision_id = ?`,
    )
    .bind(organisationId, revisionId)
    .first<SupplierDestinationRow>();
  return row ?? undefined;
}

const DESTINATION_SELECT = `
  SELECT revision_id AS revisionId, destination_id AS destinationId,
         supplier_id AS supplierId, rail, masked_summary AS maskedSummary,
         configuration_ref AS configurationRef, state,
         proposed_by AS proposedBy, activated_by AS activatedBy,
         revision, destination_json AS destinationJson
  FROM supplier_destination_revision`;
