/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";

import {
  parseActorActivationToken,
  parseActorFenceToken,
  parseActorRegistryId,
  actorPhysicalName,
  type ActorActivationIdentity,
} from "@purin-labs/actor-runtime/actors/actor-registry";
import {
  activateActor,
  createActorActivationSchema,
  inspectActorActivation,
} from "@purin-labs/actor-runtime/actors/actor-activation";
import { parseOrganisationId } from "@purin-labs/kernel/ids";
import { parseOrganisationPlacement } from "@purin-labs/tenancy/placement";
import { emptySqliteFixture } from "./sqlite-storage";

describe("actor activation", function actorActivationSuite() {
  it("activates once and accepts an exact retry", function activatesIdempotently() {
    const fixture = emptySqliteFixture();
    const request = activationRequest();
    createActorActivationSchema(fixture.storage);

    const first = activateActor(fixture.storage, request);
    const retry = activateActor(fixture.storage, {
      ...request,
      requestedAt: request.requestedAt + 10,
    });

    expect(first).toEqual({
      ok: true,
      value: {
        kind: "activated",
        registryId: request.registryId,
        stateVersion: 1,
      },
    });
    expect(retry).toEqual(first);
  });

  it("rejects a reservation for different physical state", function rejectsConflict() {
    const fixture = emptySqliteFixture();
    const request = activationRequest();
    const conflicting = conflictingActivationRequest(request);
    createActorActivationSchema(fixture.storage);

    activateActor(fixture.storage, request);

    expect(activateActor(fixture.storage, conflicting)).toEqual({
      ok: false,
      error: { code: "activation_conflict" },
    });
  });

  it("reports schema and identity differences without mutating activation state", function inspectsActivation() {
    const fixture = emptySqliteFixture();
    const request = activationRequest();
    const schemaMismatch = { ...request, schemaVersion: 2 };
    const identityMismatch = conflictingActivationRequest(request);
    createActorActivationSchema(fixture.storage);
    activateActor(fixture.storage, request);

    expect(inspectActorActivation(fixture.storage, request)).toEqual({
      kind: "match",
      schemaVersion: 1,
      stateVersion: 1,
    });
    expect(inspectActorActivation(fixture.storage, schemaMismatch)).toEqual({
      kind: "mismatch",
      reason: "schema",
      schemaVersion: 1,
      stateVersion: 1,
    });
    expect(inspectActorActivation(fixture.storage, identityMismatch)).toEqual({
      kind: "mismatch",
      reason: "identity",
      schemaVersion: 1,
      stateVersion: 1,
      mismatchedFields: ["activationToken"],
    });
    expect(activateActor(fixture.storage, request)).toEqual({
      ok: true,
      value: {
        kind: "activated",
        registryId: request.registryId,
        stateVersion: 1,
      },
    });
  });
});

function activationRequest(): ActorActivationIdentity {
  const organisationId = parseOrganisationId("organisation_activation_test");
  const placement = parseOrganisationPlacement({
    kind: "affinity",
    placementEpoch: 1,
    placementCellId: "multi-region-preview",
    locationHint: "wnam",
  });
  const registryId = parseActorRegistryId("dor_activation_test");
  const activationToken = parseActorActivationToken("doa_activation_test");
  const fenceToken = parseActorFenceToken("dof_activation_test");

  if (
    !organisationId.ok ||
    !placement.ok ||
    !registryId.ok ||
    !activationToken.ok ||
    !fenceToken.ok
  ) {
    throw new Error("activation fixture invariant failed");
  }

  const identity = {
    objectKind: "organisation" as const,
    organisationId: organisationId.value,
    logicalObjectId: organisationId.value,
  };

  return {
    registryId: registryId.value,
    activationToken: activationToken.value,
    identity,
    physicalObjectName: actorPhysicalName(identity, placement.value),
    placement: placement.value,
    schemaVersion: 1,
    fenceToken: fenceToken.value,
    requestedAt: 100,
  };
}

function conflictingActivationRequest(
  request: ActorActivationIdentity,
): ActorActivationIdentity {
  const activationToken = parseActorActivationToken("doa_activation_conflict");

  if (!activationToken.ok) {
    throw new Error("activation conflict fixture invariant failed");
  }

  return {
    ...request,
    activationToken: activationToken.value,
    requestedAt: request.requestedAt + 20,
  };
}
