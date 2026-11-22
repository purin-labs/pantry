import type { DeviceFleetActor } from "../../actors/device-fleet";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";

/** The Actor of one shop location, placed where the Organisation is. */
export function deviceFleetStub(
  env: Env,
  scope: OrganisationExecutionScope,
  locationId: string,
): DurableObjectStub<DeviceFleetActor> | null {
  return env.DEVICE_FLEET === undefined
    ? null
    : deviceFleetStubAt(
        env.DEVICE_FLEET,
        scope.organisationId,
        scope.placement,
        locationId,
      );
}

export function deviceFleetStubAt(
  namespace: DurableObjectNamespace<DeviceFleetActor>,
  organisationId: OrganisationId,
  placement: OrganisationExecutionScope["placement"],
  locationId: string,
): DurableObjectStub<DeviceFleetActor> {
  const placed =
    placement.kind === "residency"
      ? namespace.jurisdiction(placement.residencyJurisdiction)
      : namespace;
  return placed.get(
    placed.idFromName(`device_fleet:${organisationId}:${locationId}`),
    { locationHint: placement.locationHint },
  );
}
