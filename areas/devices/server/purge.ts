import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { deviceFleetStubAt } from "@purin-labs/area-devices-contract/server/fleet-stub";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
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
