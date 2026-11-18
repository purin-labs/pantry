import type { CommerceDatabase } from "../../database.ts";

/**
 * The merchant's external reference, which food-service provenance names as
 * its `organisationId` (Plan 80 step 2: commands no longer carry it).
 */
export function merchantOwner(
  database: CommerceDatabase,
  merchantId: string,
): string {
  const row = database
    .prepare(
      "SELECT external_reference AS externalReference FROM merchant WHERE merchant_id = ?",
    )
    .get<Readonly<{ externalReference: string }>>(merchantId);
  if (row === undefined) throw new Error(`Merchant ${merchantId} is missing`);
  return row.externalReference;
}
