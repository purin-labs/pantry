import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationPlacement } from "@purin-labs/tenancy/placement";
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

/**
 * The stub of each placed Actor, as its binding gives it (Refactor 17, step
 * A1.1). Code outside the Actor's own file names these types and not the
 * class. The Actor files add these bindings to `Env` with a declaration
 * merge, so the types are here and not in `env.ts`: the kernel then reads no
 * merged key, and it can be a package of its own (Stage B, decision D1).
 */
export type OrganisationActorStub = ReturnType<Env["ORGANISATION"]["get"]>;
export type SessionActorStub = ReturnType<Env["SESSION"]["get"]>;
export type CaseActorStub = ReturnType<Env["CASE"]["get"]>;
export type ConnectorActorStub = ReturnType<Env["CONNECTOR"]["get"]>;
