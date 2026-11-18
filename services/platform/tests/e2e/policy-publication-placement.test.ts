import { env } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, it, vi, type TestContext } from "vitest";
import { BindingObservation } from "./binding-observation";
import * as placementData from "../../src/data/organisation-placement";
import * as policy from "../../src/policy-snapshot";
import {
  startActorRelocation,
  resumeActorRelocation,
  type ActorRelocationId,
} from "../../src/actors/actor-relocation";
import { requireActiveOrganisationActor } from "../../src/actors/actor-router";
import type { OrganisationDO } from "../../src/actors/organisation";
import {
  installSlackActorFixture,
  ORGANISATION_ID,
} from "./slack-journey-support";

const readPlacement = placementData.resolveActiveOrganisationPlacementRecord;
const readPolicyPlacement = policy.isOrganisationPolicyPlacementActive;
const putKv = env.POLICY_KV.put.bind(env.POLICY_KV);

type Race = {
  readonly targetCell: string;
  relocationId: ActorRelocationId | null;
};

it(
  "fences policy snapshot, Actor activation and KV settlement across relocation and recovery",
  policyPlacementJourney,
  70_000,
);

async function policyPlacementJourney({ task }: TestContext) {
  await installSlackActorFixture();
  const observation = new BindingObservation();
  const kv = observation.kv(env.POLICY_KV);
  let organisation = await currentOrganisation();
  const initial = await publicationEvidence(organisation);
  const snapshotRace: Race = {
    targetCell: "e2e-policy-snapshot",
    relocationId: null,
  };
  const snapshotPause = vi
    .spyOn(placementData, "resolveActiveOrganisationPlacementRecord")
    .mockImplementationOnce(freezeAfterPlacementRead.bind(null, snapshotRace));
  try {
    const result = await publish(kv, organisation);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "policy_settlement_failed" },
    });
    expect(snapshotPause).toHaveBeenCalled();
  } finally {
    snapshotPause.mockRestore();
  }
  expect(await publicationEvidence(organisation)).toEqual({
    ...initial,
    barrier: 1,
  });
  await recover(snapshotRace);
  organisation = await currentOrganisation();
  expect((await publish(kv, organisation)).ok).toBe(true);

  const actorBefore = await publicationEvidence(organisation);
  const actorRace: Race = {
    targetCell: "e2e-policy-activation",
    relocationId: null,
  };
  const actorPause = vi
    .spyOn(policy, "isOrganisationPolicyPlacementActive")
    .mockImplementationOnce(freezeAfterPolicyRead.bind(null, actorRace));
  try {
    const result = await publish(kv, organisation);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "policy_activation_failed",
        detail: "policy_placement_conflict",
      },
    });
    expect(actorPause).toHaveBeenCalled();
  } finally {
    actorPause.mockRestore();
  }
  const actorAfter = await publicationEvidence(organisation);
  expect(actorAfter.head).toEqual(actorBefore.head);
  expect(actorAfter.kv).toEqual(actorBefore.kv);
  expect(actorAfter.snapshots).toBe(actorBefore.snapshots + 1);
  expect(actorAfter.barrier).toBe(1);
  await evictDurableObject(organisation);
  expect((await publicationEvidence(organisation)).barrier).toBe(1);
  await recover(actorRace);
  organisation = await currentOrganisation();
  expect((await reconcile(kv, organisation)).ok).toBe(true);
  expect((await publicationEvidence(organisation)).barrier).toBe(0);

  const kvRace: Race = { targetCell: "e2e-policy-kv", relocationId: null };
  const kvPause = vi
    .spyOn(env.POLICY_KV, "put")
    .mockImplementation(freezeAfterLatestKv.bind(null, kvRace));
  try {
    const result = await publish(kv, organisation);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "policy_settlement_failed" },
    });
    expect(kvRace.relocationId).not.toBeNull();
  } finally {
    kvPause.mockRestore();
  }
  await recover(kvRace);
  organisation = await currentOrganisation();
  expect((await publish(kv, organisation)).ok).toBe(true);
  const loaded = await policy.loadOrganisationPolicy({
    bindings: { db: fixtureDatabase(), kv },
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  expect(loaded.ok).toBe(true);
  const bindingUsage = observation.snapshot();
  expect(bindingUsage.kind).toBe("settled_calls");
  expect(bindingUsage.operations["kv.put"]?.fulfilled).toBeGreaterThan(0);
  expect(bindingUsage.operations["kv.get"]?.fulfilled).toBeGreaterThan(0);
  Object.assign(task.meta, {
    policyPlacementEvidence: {
      snapshotRace: "no snapshot, Actor head or KV change",
      actorRace:
        "snapshot accepted before freeze; exported Actor head rejects resumed activation",
      eviction: "source barrier persisted; target barrier absent",
      kvRace: "no successful settlement after freeze during KV write",
      recovery: "reconciled and published from new placement",
      final: await publicationEvidence(organisation),
      bindingUsage,
    },
  });
}

function currentOrganisation() {
  return requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
}
function publish(
  kv: KVNamespace,
  organisation: DurableObjectStub<OrganisationDO>,
) {
  return policy.compilePublishAndActivateOrganisationPolicy({
    bindings: { db: fixtureDatabase(), kv },
    organisationId: ORGANISATION_ID,
    organisation,
    now: Date.now(),
  });
}
function reconcile(
  kv: KVNamespace,
  organisation: DurableObjectStub<OrganisationDO>,
) {
  return policy.reconcileOrganisationPolicyPublication({
    bindings: { db: fixtureDatabase(), kv },
    organisationId: ORGANISATION_ID,
    organisation,
    now: Date.now(),
  });
}
async function freezeAfterPlacementRead(
  race: Race,
  ...args: Parameters<typeof readPlacement>
) {
  const current = await readPlacement(...args);
  if (!current.ok) throw new Error(current.error.code);
  await freezeAndExport(race);
  return current;
}
async function freezeAfterPolicyRead(
  race: Race,
  ...args: Parameters<typeof readPolicyPlacement>
) {
  const active = await readPolicyPlacement(...args);
  expect(active).toBe(true);
  await freezeAndExport(race);
  return active;
}
async function freezeAfterLatestKv(
  race: Race,
  ...args: Parameters<typeof putKv>
) {
  await putKv(...args);
  if (args[0].endsWith(":latest") && race.relocationId === null)
    await freezeAndExport(race);
}
async function freezeAndExport(race: Race) {
  const target = placementData.parseOrganisationPlacementMoveTarget({
    kind: "affinity",
    placementCellId: race.targetCell,
    locationHint: "wnam",
  });
  if (!target.ok) throw new Error(target.error.code);
  const move = await startActorRelocation({
    env,
    organisationId: ORGANISATION_ID,
    target: target.value,
    now: Date.now(),
  });
  if (!move.ok) throw new Error(JSON.stringify(move.error));
  race.relocationId = move.value.relocationId;
  await env.DB.prepare(
    `CREATE TRIGGER policy_race_hold BEFORE UPDATE OF status ON state_object_relocation
    WHEN NEW.status = 'published' BEGIN SELECT RAISE(ABORT, 'policy_race_hold'); END`,
  ).run();
  await expect(
    resumeActorRelocation({
      env,
      relocationId: move.value.relocationId,
      now: Date.now(),
    }),
  ).rejects.toThrow("policy_race_hold");
}
async function recover(race: Race) {
  if (race.relocationId === null)
    throw new Error("Race did not freeze placement");
  await env.DB.prepare("DROP TRIGGER policy_race_hold").run();
  const result = await resumeActorRelocation({
    env,
    relocationId: race.relocationId,
    now: Date.now(),
  });
  expect(result).toMatchObject({ ok: true, value: { status: "retained" } });
}
async function publicationEvidence(
  organisation: DurableObjectStub<OrganisationDO>,
) {
  const local = await runInDurableObject(organisation, localPolicyEvidence);
  const count = await fixtureDatabase()
    .prepare(
      "SELECT count(*) AS count FROM policy_snapshot WHERE organisation_id = ?",
    )
    .bind(ORGANISATION_ID)
    .first<{ count: number }>();
  return {
    ...local,
    snapshots: count?.count ?? 0,
    kv: await env.POLICY_KV.get(`policy:${ORGANISATION_ID}:latest`),
  };
}
function localPolicyEvidence(
  _instance: OrganisationDO,
  state: DurableObjectState,
) {
  return {
    head: state.storage.sql
      .exec("SELECT active_version, digest FROM organisation_policy_head")
      .toArray(),
    barrier: state.storage.sql
      .exec<{ count: number }>(
        "SELECT count(*) AS count FROM state_object_policy_export_barrier",
      )
      .one().count,
  };
}
