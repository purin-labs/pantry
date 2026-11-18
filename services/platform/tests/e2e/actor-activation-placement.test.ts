import { env } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, it, vi, type TestContext } from "vitest";
import {
  actorActivationIdentity,
  actorActivationRequest,
  activateActorRegistryEntry,
  beginActorExport,
  retireActorRegistryEntry,
  reserveActor,
  reserveActorPair,
  type ActorRegistryEntry,
} from "../../src/actors/actor-registry";
import {
  actorStubForRegistryEntry,
  publishActorRegistryActivation,
  resolveActiveCaseSessionActorsAtPlacement,
} from "../../src/actors/actor-router";
import {
  actorRelocationAdmission,
  actorPlacementDirectoryAdmits,
  resolveActorExecutionAdmission,
  type ActorPlacementAdmission,
} from "../../src/actors/actor-placement-admission";
import {
  startActorRelocation,
  resumeActorRelocation,
  ACTOR_RELOCATION_RETENTION_MS,
} from "../../src/actors/actor-relocation";
import {
  startActorRestore,
  resumeActorRestore,
} from "../../src/actors/actor-restore";
import {
  prepareActorRestoreManifest,
  parseActorRestoreManifest,
  canonicalActorRestoreManifestJson,
} from "../../src/actors/actor-restore-manifest";
import { CANONICAL_SESSION_SCHEMA_VERSION } from "../../src/actors/agent-session-schema";
import {
  CASE_ACTOR_SCHEMA_VERSION,
  CONNECTOR_ACTOR_SCHEMA_VERSION,
} from "../../src/actors/actor-schema-versions";
import { parseCaseId, parseConnectorId, parseSessionId } from "../../src/ids";
import { readOrganisationPlacementMove } from "../../src/data/organisation-placement";
import {
  installDiscoveryActorFixture,
  ORGANISATION_ID,
  OTHER_ORGANISATION_ID,
} from "./slack-journey-support";
import {
  interceptPlacementSession,
  type PlacementRace,
} from "./placement-race-support";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { moveTarget, placementEntries } from "./placement-move-support";

it(
  "drains activation before freeze and fences registry commits through relocation, restore and eviction",
  activationPlacementJourney,
  100_000,
);

async function activationPlacementJourney({
  task,
}: TestContext): Promise<void> {
  const fixture = await installDiscoveryActorFixture();
  const sourceScope = await requireOrganisationExecutionScope(
    env,
    ORGANISATION_ID,
  );
  const admission = await executionAdmission(sourceScope.placement);
  const target = moveTarget();
  const started = await startActorRelocation({
    env,
    organisationId: ORGANISATION_ID,
    target,
    now: Date.now(),
  });
  if (!started.ok) throw new Error(started.error.code);
  const caseId = parseCaseId("case_activation_placement");
  const sessionId = parseSessionId("session_activation_placement");
  const connectorId = parseConnectorId(
    `connector_slack_${fixture.selectedIntegrationAccountId}`,
  );
  if (!caseId.ok || !sessionId.ok || !connectorId.ok)
    throw new Error("Invalid Actor fixture identity");
  const pair = await reserveActorPair({
    db: fixtureDatabase(),
    reservations: [
      {
        admission,
        identity: {
          objectKind: "case",
          organisationId: ORGANISATION_ID,
          logicalObjectId: caseId.value,
        },
        schemaVersion: CASE_ACTOR_SCHEMA_VERSION,
        now: Date.now(),
      },
      {
        admission,
        identity: {
          objectKind: "session",
          organisationId: ORGANISATION_ID,
          logicalObjectId: sessionId.value,
        },
        schemaVersion: CANONICAL_SESSION_SCHEMA_VERSION,
        now: Date.now(),
      },
    ],
  });
  const connector = await reserveActor({
    db: fixtureDatabase(),
    admission,
    identity: {
      objectKind: "connector",
      organisationId: ORGANISATION_ID,
      logicalObjectId: connectorId.value,
    },
    schemaVersion: CONNECTOR_ACTOR_SCHEMA_VERSION,
    now: Date.now(),
  });
  if (!pair.ok || !connector.ok) throw new Error("Missing reserved Actors");
  const reservations = [...pair.value, connector.value];
  await expectFreezeRefused(started.value.relocationId);
  const reservedCase = pair.value[0];
  if (reservedCase.lifecycleStatus !== "reserved")
    throw new Error("Case is already activated");
  for (const database of [env.DB, fixtureDatabase()])
    await database
      .prepare(
        "UPDATE organisation_placement SET location_hint = ? WHERE organisation_id = ? AND placement_epoch = ?",
      )
      .bind("eeur", ORGANISATION_ID, sourceScope.placement.placementEpoch)
      .run();
  const caseActor = stub(reservedCase);
  expect(
    await caseActor.activate(
      actorActivationRequest(reservedCase, Date.now(), admission),
    ),
  ).toMatchObject({
    ok: false,
    error: { code: "activation_placement_conflict" },
  });
  expect(await runInDurableObject(caseActor, activationRows)).toEqual([]);
  for (const database of [env.DB, fixtureDatabase()])
    await database
      .prepare(
        "UPDATE organisation_placement SET location_hint = ? WHERE organisation_id = ? AND placement_epoch = ?",
      )
      .bind(
        sourceScope.placement.locationHint,
        ORGANISATION_ID,
        sourceScope.placement.placementEpoch,
      )
      .run();
  const activated = [];
  for (const entry of reservations) {
    if (entry.lifecycleStatus !== "reserved")
      throw new Error("Actor is already activated");
    const result = await stub(entry).activate(
      actorActivationRequest(entry, Date.now(), admission),
    );
    if (!result.ok) throw new Error(result.error.code);
    activated.push({ entry, stateVersion: result.value.stateVersion });
  }
  await expectFreezeRefused(started.value.relocationId);
  expect(
    await publishActorRegistryActivation({
      env,
      publication: {
        admission,
        activations: activated.slice(0, 2),
        activatedAt: Date.now(),
      },
    }),
  ).toMatchObject({ ok: true });
  const connectorActivation = activated[2];
  if (connectorActivation === undefined)
    throw new Error("Missing Connector activation");
  expect(
    await activateActorRegistryEntry({
      db: fixtureDatabase(),
      admission,
      registryId: connectorActivation.entry.registryId,
      activationToken: connectorActivation.entry.activationToken,
      stateVersion: connectorActivation.stateVersion,
      now: Date.now(),
    }),
  ).toMatchObject({ ok: true });
  for (const entry of await placementEntries(
    sourceScope.placement.placementEpoch,
  )) {
    await runInDurableObject(stub(entry), advanceFixtureStateVersion);
    await fixtureDatabase()
      .prepare(
        "UPDATE durable_object_registry SET state_version = 7 WHERE registry_id = ?",
      )
      .bind(entry.registryId)
      .run();
  }
  const refreshed = await startActorRelocation({
    env,
    organisationId: ORGANISATION_ID,
    target,
    now: Date.now(),
  });
  expect(refreshed).toMatchObject({
    ok: true,
    value: { relocationId: started.value.relocationId },
  });
  const sourceEntries = await placementEntries(
    sourceScope.placement.placementEpoch,
  );
  expect(sourceEntries).toHaveLength(4);

  const race: PlacementRace = {
    organisationId: ORGANISATION_ID,
    phase: { kind: "waiting" },
  };
  const withSession = fixtureDatabase().withSession.bind(fixtureDatabase());
  const interceptor = vi
    .spyOn(fixtureDatabase(), "withSession")
    .mockImplementation(
      interceptPlacementSession.bind(null, race, withSession),
    );
  const blockedCase = parseCaseId("case_activation_blocked");
  if (!blockedCase.ok) throw new Error(blockedCase.error.code);
  try {
    expect(
      await reserveActor({
        db: fixtureDatabase(),
        admission,
        identity: {
          objectKind: "case",
          organisationId: ORGANISATION_ID,
          logicalObjectId: blockedCase.value,
        },
        schemaVersion: CASE_ACTOR_SCHEMA_VERSION,
        now: Date.now(),
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "registry_placement_conflict" },
    });
  } finally {
    interceptor.mockRestore();
    await env.DB.prepare(
      "DROP TRIGGER IF EXISTS lifecycle_interrupt_publication",
    ).run();
  }
  if (race.phase.kind !== "frozen")
    throw new Error("Relocation did not freeze");
  expect(
    await fixtureDatabase()
      .prepare(
        "SELECT COUNT(*) AS count FROM durable_object_registry WHERE organisation_id = ? AND logical_object_id = ?",
      )
      .bind(ORGANISATION_ID, blockedCase.value)
      .first("count"),
  ).toBe(0);
  expect(
    await reserveActorPair({
      db: fixtureDatabase(),
      reservations: [
        {
          admission,
          identity: {
            objectKind: "case",
            organisationId: ORGANISATION_ID,
            logicalObjectId: blockedCase.value,
          },
          schemaVersion: CASE_ACTOR_SCHEMA_VERSION,
          now: Date.now(),
        },
        {
          admission,
          identity: {
            objectKind: "session",
            organisationId: ORGANISATION_ID,
            logicalObjectId: sessionId.value,
          },
          schemaVersion: CANONICAL_SESSION_SCHEMA_VERSION,
          now: Date.now(),
        },
      ],
    }),
  ).toMatchObject({
    ok: false,
    error: { code: "registry_placement_conflict" },
  });
  const frozenRegistry = await placementEntries(
    sourceScope.placement.placementEpoch,
  );
  for (const entry of sourceEntries) {
    if (entry.lifecycleStatus !== "active")
      throw new Error("Source Actor is not active");
    const actor = stub(entry);
    await evictDurableObject(actor);
    const before = await runInDurableObject(actor, activationRows);
    expect(
      await actor.activate(
        actorActivationRequest(entry, Date.now(), admission),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "activation_placement_conflict" },
    });
    expect(await runInDurableObject(actor, activationRows)).toEqual(before);
  }
  expect(
    await publishActorRegistryActivation({
      env,
      publication: {
        admission,
        activations: activated.slice(0, 2),
        activatedAt: Date.now(),
      },
    }),
  ).toMatchObject({
    ok: false,
    error: { code: "organisation_placement_missing" },
  });
  expect(
    await publishActorRegistryActivation({
      env,
      publication: {
        admission,
        activations: [],
        activatedAt: Date.now(),
      },
    }),
  ).toMatchObject({
    ok: false,
    error: { code: "organisation_placement_missing" },
  });
  expect(await placementEntries(sourceScope.placement.placementEpoch)).toEqual(
    frozenRegistry,
  );

  const move = await readOrganisationPlacementMove({
    db: env.DB,
    organisationId: ORGANISATION_ID,
    sourcePlacementEpoch: sourceScope.placement.placementEpoch,
    targetPlacementEpoch: sourceScope.placement.placementEpoch + 1,
  });
  if (
    !move.ok ||
    move.value.source.status !== "frozen" ||
    move.value.target.status !== "reserved"
  )
    throw new Error("Missing frozen move");
  const frozenMove = {
    organisationId: ORGANISATION_ID,
    source: move.value.source,
    target: move.value.target,
  };
  const staged = actorRelocationAdmission(frozenMove, race.phase.relocationId, {
    objectKind: "case",
    organisationId: ORGANISATION_ID,
    logicalObjectId: caseId.value,
  });
  expect(
    await resolveActorExecutionAdmission(
      env.DB,
      ORGANISATION_ID,
      staged.placement,
    ),
  ).toMatchObject({
    ok: false,
    error: { code: "registry_placement_conflict" },
  });
  const foreign = await startActorRelocation({
    env,
    organisationId: OTHER_ORGANISATION_ID,
    target,
    now: Date.now(),
  });
  if (!foreign.ok) throw new Error(foreign.error.code);
  const targetEntries = await placementEntries(staged.placement.placementEpoch);
  expect(targetEntries).toHaveLength(4);
  for (const entry of targetEntries) {
    if (entry.lifecycleStatus !== "active")
      throw new Error("Target Actor is not staged");
    const actor = stub(entry);
    const wrongOperation = actorRelocationAdmission(
      frozenMove,
      foreign.value.relocationId,
      entry.identity,
    );
    const stagedActor = actorRelocationAdmission(
      frozenMove,
      race.phase.relocationId,
      entry.identity,
    );
    await evictDurableObject(actor);
    expect(
      await actor.activate(
        actorActivationRequest(entry, Date.now(), wrongOperation),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "activation_placement_conflict" },
    });
    expect(
      await actor.activate(
        actorActivationRequest(entry, Date.now(), stagedActor),
      ),
    ).toMatchObject({ ok: true });
    if (entry.identity.objectKind !== "case") {
      expect(
        await actor.activate(actorActivationRequest(entry, Date.now(), staged)),
      ).toMatchObject({
        ok: false,
        error: { code: "activation_placement_conflict" },
      });
      expect(
        await activateActorRegistryEntry({
          db: fixtureDatabase(),
          admission: staged,
          registryId: entry.registryId,
          activationToken: entry.activationToken,
          stateVersion: entry.stateVersion,
          now: Date.now(),
        }),
      ).toMatchObject({
        ok: false,
        error: { code: "registry_placement_conflict" },
      });
    }
  }
  expect(
    await actorPlacementDirectoryAdmits(
      env.DB,
      actorRelocationAdmission(frozenMove, race.phase.relocationId, {
        objectKind: "case",
        organisationId: ORGANISATION_ID,
        logicalObjectId: blockedCase.value,
      }),
    ),
  ).toBe(false);
  expect(await placementEntries(staged.placement.placementEpoch)).toEqual(
    targetEntries,
  );
  expect(
    await resumeActorRelocation({
      env,
      relocationId: race.phase.relocationId,
      now: Date.now(),
    }),
  ).toMatchObject({ ok: true, value: { status: "retained" } });
  const current = await executionAdmission(staged.placement);
  for (const entry of targetEntries) {
    if (entry.lifecycleStatus !== "active")
      throw new Error("Target Actor is not active");
    expect(
      await stub(entry).activate(
        actorActivationRequest(
          entry,
          Date.now(),
          actorRelocationAdmission(
            frozenMove,
            race.phase.relocationId,
            entry.identity,
          ),
        ),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "activation_placement_conflict" },
    });
    expect(
      await stub(entry).activate(
        actorActivationRequest(entry, Date.now(), current),
      ),
    ).toMatchObject({ ok: true });
  }
  for (const entry of sourceEntries) {
    if (entry.lifecycleStatus !== "active")
      throw new Error("Invalid source entry");
    expect(
      await stub(entry).activate(
        actorActivationRequest(entry, Date.now(), admission),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "activation_placement_conflict" },
    });
  }
  const manifest = await prepareActorRestoreManifest({
    env,
    relocationId: race.phase.relocationId,
    now: Date.now(),
  });
  if (!manifest.ok) throw new Error(manifest.error.code);
  // Restore requires a clean registry after the account's configuration is recovered.
  await env.DB.prepare(
    "DELETE FROM state_object_relocation_item WHERE relocation_id = ?",
  )
    .bind(race.phase.relocationId)
    .run();
  await fixtureDatabase()
    .prepare("DELETE FROM durable_object_registry WHERE organisation_id = ?")
    .bind(ORGANISATION_ID)
    .run();
  const restored = await startActorRestore({
    env,
    manifest: manifest.value,
    target,
    now: Date.now(),
  });
  if (!restored.ok) throw new Error(restored.error.code);
  expect(
    await resumeActorRestore({
      env,
      restoreId: restored.value.restoreId,
      now: Date.now(),
    }),
  ).toMatchObject({ ok: true, value: { status: "complete" } });
  const restoredScope = await requireOrganisationExecutionScope(
    env,
    ORGANISATION_ID,
  );
  const restoredEntries = await placementEntries(
    restoredScope.placement.placementEpoch,
  );
  expect(restoredEntries).toHaveLength(4);
  for (const entry of restoredEntries) {
    expect(entry.stateVersion).toBe(7);
    expect(await runInDurableObject(stub(entry), activationRows)).toMatchObject(
      [{ state_version: 7 }],
    );
  }
  for (const entry of restoredEntries) await evictDurableObject(stub(entry));
  const recovered = await resolveActiveCaseSessionActorsAtPlacement({
    env,
    caseNamespace: env.CASE,
    sessionNamespace: env.SESSION,
    organisationId: ORGANISATION_ID,
    caseId: caseId.value,
    sessionId: sessionId.value,
    placement: restoredScope.placement,
    now: Date.now(),
  });
  if (!recovered.ok) throw new Error(recovered.error.code);
  expect(recovered.value.registryActivation.activations).toEqual([]);
  expect(
    await publishActorRegistryActivation({
      env,
      publication: recovered.value.registryActivation,
    }),
  ).toMatchObject({ ok: true });
  const caseEntry = restoredEntries.find(isCaseEntry);
  if (caseEntry === undefined || caseEntry.lifecycleStatus !== "active")
    throw new Error("Missing restored Case");
  expect(
    await recovered.value.caseActor.inspectActivation(
      actorActivationIdentity(caseEntry, Date.now()),
    ),
  ).toMatchObject({ kind: "match", stateVersion: 7 });
  expect(await env.DB.prepare("PRAGMA foreign_key_check").all()).toMatchObject({
    results: [],
  });
  Object.assign(task.meta, {
    activationPlacement: {
      relocationId: race.phase.relocationId,
      restoreId: restored.value.restoreId,
      reservationFreezeRefused: true,
      unpublishedActivationFreezeRefused: true,
      changedInventoryFreezeRefused: true,
      frozenActorActivationsRejected: 4,
      copiedActors: targetEntries.length,
      restoredActors: restoredEntries.length,
      upgradedStateVersionPreserved: true,
      foreignOperationRejected: true,
      unlistedCopyRejected: true,
      retiredSourceRejected: true,
      recoveryAfterEviction: true,
    },
  });
}

async function executionAdmission(
  placement: ActorPlacementAdmission["placement"],
) {
  const admission = await resolveActorExecutionAdmission(
    env.DB,
    ORGANISATION_ID,
    placement,
  );
  if (!admission.ok) throw new Error(admission.error.code);
  return admission.value;
}

async function expectFreezeRefused(
  relocationId: Parameters<typeof resumeActorRelocation>[0]["relocationId"],
) {
  const result = await resumeActorRelocation({
    env,
    relocationId,
    now: Date.now(),
  });
  expect(result, JSON.stringify(result)).toMatchObject({
    ok: false,
    error: { code: "organisation_placement_move_conflict" },
  });
  expect(
    await env.DB.prepare(
      "SELECT status FROM organisation_placement WHERE organisation_id = ? AND placement_epoch = 1",
    )
      .bind(ORGANISATION_ID)
      .first("status"),
  ).toBe("active");
  expect(
    await env.DB.prepare(
      "SELECT status FROM state_object_relocation WHERE relocation_id = ?",
    )
      .bind(relocationId)
      .first("status"),
  ).toBe("reserved");
}

function stub(entry: ActorRegistryEntry) {
  return actorStubForRegistryEntry({
    namespaces: {
      organisation: env.ORGANISATION,
      case: env.CASE,
      session: env.SESSION,
      connector: env.CONNECTOR,
    },
    entry,
  });
}

function activationRows(_instance: unknown, ctx: DurableObjectState) {
  return ctx.storage.sql
    .exec("SELECT * FROM state_object_activation")
    .toArray();
}

function advanceFixtureStateVersion(
  _instance: unknown,
  ctx: DurableObjectState,
): void {
  ctx.storage.sql.exec(
    "UPDATE state_object_activation SET state_version = 7 WHERE singleton = 1",
  );
}

function isCaseEntry(entry: ActorRegistryEntry): boolean {
  return entry.identity.objectKind === "case";
}

it(
  "preserves retired identities through two moves and recovery without recreation",
  retiredIdentityJourney,
  100_000,
);

async function retiredIdentityJourney({ task }: TestContext): Promise<void> {
  await installDiscoveryActorFixture();
  const source = await requireOrganisationExecutionScope(env, ORGANISATION_ID);
  const caseId = parseCaseId("case_deleted_identity");
  const sessionId = parseSessionId("session_deleted_identity");
  if (!caseId.ok || !sessionId.ok) throw new Error("Invalid deletion fixture");
  const actors = await resolveActiveCaseSessionActorsAtPlacement({
    env,
    caseNamespace: env.CASE,
    sessionNamespace: env.SESSION,
    organisationId: ORGANISATION_ID,
    caseId: caseId.value,
    sessionId: sessionId.value,
    placement: source.placement,
    now: Date.now(),
  });
  if (!actors.ok) throw new Error(actors.error.code);
  const published = await publishActorRegistryActivation({
    env,
    publication: actors.value.registryActivation,
  });
  if (!published.ok) throw new Error(published.error.code);
  const initial = await placementEntries(source.placement.placementEpoch);
  let retiredCount = 0;
  for (const entry of initial) {
    if (
      entry.identity.logicalObjectId !== caseId.value &&
      entry.identity.logicalObjectId !== sessionId.value
    )
      continue;
    const exporting = await beginActorExport({
      db: fixtureDatabase(),
      registryId: entry.registryId,
      expectedFenceToken: entry.fenceToken,
      now: Date.now(),
    });
    if (!exporting.ok) throw new Error(exporting.error.code);
    const retired = await retireActorRegistryEntry({
      db: fixtureDatabase(),
      registryId: entry.registryId,
      expectedFenceToken: entry.fenceToken,
      now: Date.now(),
    });
    if (!retired.ok) throw new Error(retired.error.code);
    retiredCount += 1;
  }
  expect(retiredCount).toBe(2);
  for (let moveIndex = 0; moveIndex < 2; moveIndex += 1) {
    const started = await startActorRelocation({
      env,
      organisationId: ORGANISATION_ID,
      target: moveTarget(),
      now: Date.now(),
    });
    if (!started.ok) throw new Error(started.error.code);
    const moved = await resumeActorRelocation({
      env,
      relocationId: started.value.relocationId,
      now: Date.now(),
    });
    expect(moved, JSON.stringify(moved)).toMatchObject({
      ok: true,
      value: { status: "retained" },
    });
    const scope = await requireOrganisationExecutionScope(env, ORGANISATION_ID);
    const records = await placementEntries(scope.placement.placementEpoch);
    expect(records.filter(isRetiredEntry)).toHaveLength(2);
    const rejected = await resolveActiveCaseSessionActorsAtPlacement({
      env,
      caseNamespace: env.CASE,
      sessionNamespace: env.SESSION,
      organisationId: ORGANISATION_ID,
      caseId: caseId.value,
      sessionId: sessionId.value,
      placement: scope.placement,
      now: Date.now(),
    });
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "registry_entry_conflict" },
    });
    const manifest = await prepareActorRestoreManifest({
      env,
      relocationId: started.value.relocationId,
      now: Date.now(),
    });
    if (!manifest.ok) throw new Error(manifest.error.code);
    expect(manifest.value.retiredActors).toHaveLength(2);
    expect(
      await parseActorRestoreManifest({ ...manifest.value, retiredActors: [] }),
    ).toMatchObject({
      ok: false,
      error: { code: "restore_manifest_checksum_mismatch" },
    });
    const recoveredManifest = await parseActorRestoreManifest(
      JSON.parse(canonicalActorRestoreManifestJson(manifest.value)),
    );
    if (!recoveredManifest.ok) throw new Error(recoveredManifest.error.code);
    if (moveIndex === 0 && moved.ok && moved.value.status === "retained") {
      const expiredAt = Date.now() - 1;
      await env.DB.prepare(
        "UPDATE state_object_relocation SET resumed_at = ?, retain_until = ? WHERE relocation_id = ?",
      )
        .bind(
          expiredAt - ACTOR_RELOCATION_RETENTION_MS,
          expiredAt,
          moved.value.relocationId,
        )
        .run();
      const cleaned = await resumeActorRelocation({
        env,
        relocationId: moved.value.relocationId,
        now: Date.now(),
      });
      expect(cleaned, JSON.stringify(cleaned)).toMatchObject({
        ok: true,
        value: { status: "complete" },
      });
    }
    if (moveIndex === 1) {
      await env.DB.prepare(
        "DELETE FROM state_object_relocation_item WHERE relocation_id IN (SELECT relocation_id FROM state_object_relocation WHERE organisation_id = ?)",
      )
        .bind(ORGANISATION_ID)
        .run();
      await fixtureDatabase()
        .prepare(
          "DELETE FROM durable_object_registry WHERE organisation_id = ?",
        )
        .bind(ORGANISATION_ID)
        .run();
      const restore = await startActorRestore({
        env,
        manifest: recoveredManifest.value,
        target: moveTarget(),
        now: Date.now(),
      });
      if (!restore.ok) throw new Error(restore.error.code);
      const restored = await resumeActorRestore({
        env,
        restoreId: restore.value.restoreId,
        now: Date.now(),
      });
      expect(restored, JSON.stringify(restored)).toMatchObject({
        ok: true,
        value: { status: "complete" },
      });
      const restoredScope = await requireOrganisationExecutionScope(
        env,
        ORGANISATION_ID,
      );
      const restoredEntries = await placementEntries(
        restoredScope.placement.placementEpoch,
      );
      expect(restoredEntries.filter(isRetiredEntry)).toHaveLength(2);
      expect(
        await resolveActiveCaseSessionActorsAtPlacement({
          env,
          caseNamespace: env.CASE,
          sessionNamespace: env.SESSION,
          organisationId: ORGANISATION_ID,
          caseId: caseId.value,
          sessionId: sessionId.value,
          placement: restoredScope.placement,
          now: Date.now(),
        }),
      ).toMatchObject({
        ok: false,
        error: { code: "registry_entry_conflict" },
      });
    }
  }
  Object.assign(task.meta, {
    retiredIdentityTransfer: {
      moves: 2,
      retiredIdentities: 2,
      recreationRejected: true,
      recoveryPreservesRetirements: true,
    },
  });
}

function isRetiredEntry(entry: ActorRegistryEntry): boolean {
  return entry.lifecycleStatus === "retired";
}
