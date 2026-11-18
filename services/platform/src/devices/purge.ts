import type { OrganisationDatabase } from "../database-handles";
import { deviceFleetStubAt } from "../actors/device-fleet";
import type { Env } from "../env";
import type { OrganisationId } from "../ids";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { eraseOrganisationSnapshots } from "./snapshots";
import { listGateways } from "./store";

/**
 * Empties the fleet Actors of an Organisation that ends. It runs before the D1
 * rows that name their locations are deleted, so that a repeat can find them.
 */
export async function purgeOrganisationDeviceFleets(
  env: Env,
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  placement: OrganisationExecutionScope["placement"],
): Promise<void> {
  await eraseOrganisationSnapshots(env, db, organisationId);
  const namespace = env.DEVICE_FLEET;
  if (namespace === undefined) return;
  const gateways = await listGateways(db, organisationId);
  const locations = new Set(gateways.map((gateway) => gateway.locationId));
  for (const locationId of locations)
    await deviceFleetStubAt(
      namespace,
      organisationId,
      placement,
      locationId,
    ).erase();
}
