import type { OrganisationPlacement } from "../placement";
import type { PlacedActor } from "./lifecycle/placed-actor";

/**
 * Typed access to an Actor (Refactor 17, step A1.1).
 *
 * This file names no Actor class. The type of a stub follows the type of the
 * namespace that the caller gives, so the Actor router and the relocation
 * code work for each Actor without an import of its class. The class of an
 * Actor belongs to the Worker: it combines the code of several modules.
 */

/**
 * The placement lifecycle of {@link PlacedActor}, which each placed Actor has:
 * activation, relocation readiness, export, import and erasure. The Actor
 * router and the relocation code need no other method of an Actor.
 */
export type PlacedActorRpc = Rpc.DurableObjectBranded &
  Pick<
    PlacedActor<unknown>,
    | "activate"
    | "inspectRelocationReadiness"
    | "exportPlacementState"
    | "importPlacementState"
    | "eraseUnregisteredState"
    | "eraseInactivePlacementState"
  >;

/**
 * The stub of an Actor at its placement. This module imports types only, so
 * a Worker that calls one Actor does not load the Actor router with it.
 */
export function actorStub<TActor extends Rpc.DurableObjectBranded | undefined>(
  namespace: DurableObjectNamespace<TActor>,
  physicalObjectName: string,
  placement: OrganisationPlacement,
): DurableObjectStub<TActor> {
  const placedNamespace =
    placement.kind === "residency"
      ? namespace.jurisdiction(placement.residencyJurisdiction)
      : namespace;
  return placedNamespace.get(placedNamespace.idFromName(physicalObjectName), {
    locationHint: placement.locationHint,
  });
}
