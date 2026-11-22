/// <reference types="@cloudflare/workers-types" />

import type { UnitTestEnv } from "./worker-fakes";
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", function cloudflareWorkersMock() {
  return {
    WorkerEntrypoint: class WorkerEntrypointMock {},
    DurableObject: class DurableObjectMock<Bindings> {
      protected readonly ctx: DurableObjectState;
      protected readonly env: Bindings;

      constructor(ctx: DurableObjectState, env: Bindings) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});

import { activateActor } from "@purin-labs/actor-runtime/actors/actor-activation";
import { CaseDO } from "../src/actors/case";
import {
  actorPhysicalName,
  parseActorActivationToken,
  parseActorFenceToken,
  parseActorRegistryId,
  type ActorActivationIdentity,
} from "@purin-labs/actor-runtime/actors/actor-registry";
import { parseCaseId, parseOrganisationId } from "@purin-labs/kernel/ids";
import { parseOrganisationPlacement } from "@purin-labs/tenancy/placement";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";

describe("quarantined Case discard", function quarantinedCaseDiscardSuite() {
  it(
    "clears state only when durable identity matches and only credentials disagree",
    discardsExactCredentialConflict,
  );
  it(
    "preserves state when any durable identity field also disagrees",
    rejectsBroaderIdentityConflict,
  );
});

async function discardsExactCredentialConflict(): Promise<void> {
  const fixture = actorFixture();
  activateActor(fixture.sql, activationRequest("old"));

  await expect(
    fixture.actor.discardQuarantinedState(activationRequest("registry")),
  ).resolves.toEqual({
    ok: true,
    value: { kind: "discarded", stateVersion: 1, reachableAttachmentCount: 0 },
  });
  expect(fixture.deleteAll).toHaveBeenCalledOnce();
}

async function rejectsBroaderIdentityConflict(): Promise<void> {
  const fixture = actorFixture();
  activateActor(fixture.sql, activationRequest("old"));
  const expected = activationRequest("registry");

  await expect(
    fixture.actor.discardQuarantinedState({
      ...expected,
      physicalObjectName: `${expected.physicalObjectName}:different`,
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "quarantined_case_discard_conflict" },
  });
  expect(fixture.deleteAll).not.toHaveBeenCalled();
}

function actorFixture(): {
  readonly actor: CaseDO;
  readonly sql: SqlStorage;
  readonly deleteAll: ReturnType<typeof vi.fn>;
} {
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  const deleteAll = vi.fn(function deleteAllStorage() {
    return Promise.resolve();
  });
  const storage = {
    sql,
    deleteAll,
    transactionSync: fixture.storage.transactionSync.bind(fixture.storage),
  } as unknown as DurableObjectStorage;
  return {
    actor: new CaseDO(
      { storage } as unknown as DurableObjectState,
      {} as UnitTestEnv,
    ),
    sql,
    deleteAll,
  };
}

function activationRequest(
  suffix: "old" | "registry",
): ActorActivationIdentity {
  const organisationId = parseOrganisationId(
    "organisation_quarantined_case_discard",
  );
  const caseId = parseCaseId("case_quarantined_case_discard");
  const registryId = parseActorRegistryId(`dor_quarantined_case_${suffix}`);
  const activationToken = parseActorActivationToken(
    `doa_quarantined_case_${suffix}`,
  );
  const fenceToken = parseActorFenceToken(`dof_quarantined_case_${suffix}`);
  const placement = parseOrganisationPlacement({
    kind: "affinity",
    placementEpoch: 1,
    placementCellId: "multi-region-preview",
    locationHint: "wnam",
  });
  if (
    !organisationId.ok ||
    !caseId.ok ||
    !registryId.ok ||
    !activationToken.ok ||
    !fenceToken.ok ||
    !placement.ok
  ) {
    throw new Error("quarantined Case discard fixture is invalid");
  }
  const identity = {
    objectKind: "case" as const,
    organisationId: organisationId.value,
    logicalObjectId: caseId.value,
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
