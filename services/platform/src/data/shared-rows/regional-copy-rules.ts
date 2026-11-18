/**
 * How the regional copier (organisation-regional-copy.ts) treats the three
 * tables that are in both baselines (Refactor 12). A move and a restore from
 * backup copy an Organisation's rows from cell to cell; these rules keep the
 * shared rows with their owners in this folder.
 */

/** The placement steps (placement-row.ts) write each cell's placement rows. */
export const COPY_EXCLUDED_SHARED_TABLES = ["organisation_placement"] as const;

/**
 * The move provisions the Organisation row in the target cell before the copy
 * (regional-move.ts), and cleanup blanks it in the old cell instead of a
 * deletion (`prepareRetiredCellOrganisationRow`).
 */
export const PROVISIONED_SHARED_TABLE = "organisation";

/**
 * A receipt moves and is restored with its Organisation's rows. Its owner
 * column is `organisation_scope`, not `organisation_id`.
 */
export const RECEIPT_TABLE = "control_mutation_receipt";
export const RECEIPT_OWNER_COLUMN = "organisation_scope";

/** The column that names the owning Organisation in a copied row. */
export function sharedRowOwnerColumn(table: string): string {
  return table === RECEIPT_TABLE ? RECEIPT_OWNER_COLUMN : "organisation_id";
}
