import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";

/** The newest open supplier payable of one purchase request. */
export type ReplenishmentPayableSummary = Readonly<{
  payableId: string;
  supplierId: string;
  currency: string;
  grossAmountMinor: number;
  settledMinor: number;
  lifecycle: string;
  revision: number;
  updatedAtMs: number;
}>;

type SupplierPayableRow = Readonly<{
  payable_id: string;
  supplier_id: string;
  purchase_request_id: string | null;
  currency: string;
  gross_amount_minor: number;
  settled_minor: number;
  lifecycle: string;
  revision: number;
  updated_at: number;
}>;

/**
 * The supplier payables of a merchant that a purchase request raised, by
 * purchase request: the newest payable that is not void.
 */
export async function readReplenishmentSupplierPayables(
  db: OrganisationDatabase,
  organisationId: string,
  merchantId: string,
): Promise<ReadonlyMap<string, ReplenishmentPayableSummary>> {
  const rows = await db
    .prepare(
      `SELECT payable_id, supplier_id, purchase_request_id,
              currency, gross_amount_minor, settled_minor, lifecycle,
              revision, updated_at
         FROM supplier_payable
        WHERE organisation_id = ?1
          AND merchant_id = ?2
          AND purchase_request_id IS NOT NULL
          AND lifecycle != 'void'
        ORDER BY updated_at DESC, payable_id ASC`,
    )
    .bind(organisationId, merchantId)
    .all<SupplierPayableRow>();

  const out = new Map<string, ReplenishmentPayableSummary>();
  for (const row of rows.results ?? []) {
    const purchaseRequestId =
      typeof row.purchase_request_id === "string"
        ? row.purchase_request_id.trim()
        : "";
    if (purchaseRequestId.length === 0 || out.has(purchaseRequestId)) {
      continue;
    }
    out.set(purchaseRequestId, {
      payableId: String(row.payable_id),
      supplierId: String(row.supplier_id),
      currency: String(row.currency),
      grossAmountMinor: nonNegativeInteger(row.gross_amount_minor),
      settledMinor: nonNegativeInteger(row.settled_minor),
      lifecycle: String(row.lifecycle),
      revision: Math.max(1, Math.trunc(Number(row.revision))),
      updatedAtMs: nonNegativeInteger(row.updated_at),
    });
  }
  return out;
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
