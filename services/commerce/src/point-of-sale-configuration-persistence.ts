import { parsePointOfSaleConfiguration } from "@purin-labs/commerce-client";
import type { PointOfSaleConfiguration } from "@purin-labs/commerce-contracts";

import type { CommerceDatabase } from "./database.ts";

/**
 * Read the published policy a counter currently sells under.
 *
 * A counter resolves its own policy from its Pantry location. It never consults
 * an online storefront, so an in-person sale does not depend on an online
 * configuration it makes no use of.
 */
export function readPublishedPointOfSaleConfiguration(
  database: CommerceDatabase,
  merchantId: string,
  pantryLocationId: string,
): PointOfSaleConfiguration | undefined {
  const row = database
    .prepare(
      `SELECT configuration_json AS configurationJson
     FROM point_of_sale_configuration
     WHERE merchant_id = ? AND satyr_location_id = ? AND lifecycle_state = 'published'`,
    )
    .get<Readonly<{ configurationJson: string }>>(merchantId, pantryLocationId);
  return row === undefined
    ? undefined
    : parsePointOfSaleConfiguration(JSON.parse(row.configurationJson));
}

/**
 * The exact configuration revision a Checkout pinned at its location.
 *
 * Placement and recovery read this rather than the currently published
 * revision, so republishing the counter policy cannot move an accepted sale.
 */
export function readPointOfSaleConfigurationForCheckout(
  database: CommerceDatabase,
  merchantId: string,
  pantryLocationId: string,
  revision: number,
): PointOfSaleConfiguration | undefined {
  const row = database
    .prepare(
      `SELECT configuration_json AS configurationJson
     FROM point_of_sale_configuration
     WHERE merchant_id = ? AND satyr_location_id = ? AND revision = ?`,
    )
    .get<Readonly<{ configurationJson: string }>>(
      merchantId,
      pantryLocationId,
      revision,
    );
  return row === undefined
    ? undefined
    : parsePointOfSaleConfiguration(JSON.parse(row.configurationJson));
}

/**
 * Publish a counter policy revision.
 *
 * Publishing retires the location's previous published revision in the same
 * step. Accepted sales keep pointing at the revision they pinned, so this only
 * affects new work.
 */
export function publishPointOfSaleConfiguration(
  database: CommerceDatabase,
  merchantId: string,
  configuration: PointOfSaleConfiguration,
  recordedAt: string,
): void {
  database
    .prepare(
      `UPDATE point_of_sale_configuration
     SET lifecycle_state = 'retired'
     WHERE merchant_id = ? AND satyr_location_id = ? AND lifecycle_state = 'published'`,
    )
    .run(merchantId, configuration.satyrLocationId);
  database
    .prepare(
      `INSERT INTO point_of_sale_configuration (
       merchant_id, configuration_id, revision, satyr_location_id,
       lifecycle_state, configuration_json, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (merchant_id, configuration_id, revision) DO UPDATE SET
       lifecycle_state = excluded.lifecycle_state,
       configuration_json = excluded.configuration_json,
       recorded_at = excluded.recorded_at`,
    )
    .run(
      merchantId,
      configuration.configurationId,
      configuration.revision,
      configuration.satyrLocationId,
      configuration.lifecycle.state,
      JSON.stringify(configuration),
      recordedAt,
    );
}
