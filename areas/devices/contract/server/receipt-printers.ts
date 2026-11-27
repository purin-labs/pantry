import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";

/**
 * Whether an active receipt printer stands on an active gateway of a
 * location. It reads the Devices records and writes nothing.
 */
export async function locationHasActiveReceiptPrinter(
  db: Pick<OrganisationDatabase, "prepare">,
  organisationId: string,
  locationId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS found FROM device_enrollment AS device
         JOIN device_gateway AS gateway ON gateway.gateway_id = device.gateway_id
        WHERE device.organisation_id = ? AND device.device_kind = 'receipt_printer'
          AND device.state = 'active' AND gateway.state = 'active'
          AND gateway.organisation_id = ? AND gateway.location_id = ?
        LIMIT 1`,
    )
    .bind(organisationId, organisationId, locationId)
    .first<{ found: number }>();
  return row !== null;
}
