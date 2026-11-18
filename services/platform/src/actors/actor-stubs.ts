import type { SessionDO } from "./agent-session";
import type { CaseDO } from "./case";
import type { ConnectorDO } from "./connector";
import type { OrganisationDO } from "./organisation";
import type { OrganisationPlacement } from "../placement";

export type ActorClass = OrganisationDO | SessionDO | CaseDO | ConnectorDO;

/**
 * The stub of an Actor at its placement. This module imports types only, so
 * a Worker that calls one Actor does not load the Actor router with it.
 */
export function actorStub<TObject extends ActorClass>(
  namespace: DurableObjectNamespace<TObject>,
  physicalObjectName: string,
  placement: OrganisationPlacement,
): DurableObjectStub<TObject> {
  const placedNamespace =
    placement.kind === "residency"
      ? namespace.jurisdiction(placement.residencyJurisdiction)
      : namespace;
  return placedNamespace.get(placedNamespace.idFromName(physicalObjectName), {
    locationHint: placement.locationHint,
  });
}

export function organisationActorStub(
  namespace: DurableObjectNamespace<OrganisationDO>,
  physicalObjectName: string,
  placement: OrganisationPlacement,
): DurableObjectStub<OrganisationDO> {
  return actorStub(namespace, physicalObjectName, placement);
}

export function sessionActorStub(
  namespace: DurableObjectNamespace<SessionDO>,
  physicalObjectName: string,
  placement: OrganisationPlacement,
): DurableObjectStub<SessionDO> {
  return actorStub(namespace, physicalObjectName, placement);
}

export function caseActorStub(
  namespace: DurableObjectNamespace<CaseDO>,
  physicalObjectName: string,
  placement: OrganisationPlacement,
): DurableObjectStub<CaseDO> {
  return actorStub(namespace, physicalObjectName, placement);
}

export function connectorActorStub(
  namespace: DurableObjectNamespace<ConnectorDO>,
  physicalObjectName: string,
  placement: OrganisationPlacement,
): DurableObjectStub<ConnectorDO> {
  return actorStub(namespace, physicalObjectName, placement);
}
