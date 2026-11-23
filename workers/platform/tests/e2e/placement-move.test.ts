// Refactor 15, refactor 5: one placement move machine for restore and
// relocation. Each journey drives the operator's admin routes and ends with
// the outcome that the operator sees: an Organisation that has an active
// placement again, a relocation that completes with a receipt for the Actor
// that it left out, and a freeze that the 15-minute run no longer refuses.
import { env, exports } from "cloudflare:workers";
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { expect, it, type TestContext } from "vitest";
import gateway from "../../src/integration-gateway";
import { fixtureDatabase } from "./organisation-database";
import {
  installDiscoveryActorFixture,
  ORGANISATION_ID,
} from "./slack-journey-support";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import {
  startActorRelocation,
  resumeActorRelocation,
} from "@purin-labs/actor-runtime/actors/actor-relocation";
import { startActorRestore } from "@purin-labs/actor-runtime/actors/actor-restore";
import { prepareActorRestoreManifest } from "@purin-labs/actor-runtime/actors/actor-restore-manifest";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { requireActiveSessionActor } from "@purin-labs/actor-runtime/actors/actor-router";
import {
  quarantineActorRegistryEntry,
  reserveActor,
} from "@purin-labs/actor-runtime/actors/actor-registry";
import { resolveActorExecutionAdmission } from "@purin-labs/actor-runtime/actors/actor-placement-admission";
import { CANONICAL_SESSION_SCHEMA_VERSION } from "@purin-labs/actor-runtime/actors/actor-schema-versions";
import { parseSessionId, type SessionId } from "@purin-labs/kernel/ids";
import { moveTarget, placementEntries } from "./placement-move-support";

it(
  "gives an Organisation an active placement again when an operator abandons a restore that stopped after the freeze",
  restoreAbandonJourney,
  100_000,
);

async function restoreAbandonJourney({ task }: TestContext): Promise<void> {
  await installDiscoveryActorFixture();
  const sessionId = sessionIdentity("session_restore_abandon");
  await requireActiveSessionActor({
    env,
    organisationId: ORGANISATION_ID,
    sessionId,
    now: Date.now(),
  });
  const relocation = await startActorRelocation({
    env,
    organisationId: ORGANISATION_ID,
    target: moveTarget(),
    now: Date.now(),
  });
  if (!relocation.ok) throw new Error(relocation.error.code);
  const relocated = await resumeActorRelocation({
    env,
    relocationId: relocation.value.relocationId,
    now: Date.now(),
  });
  expect(relocated, JSON.stringify(relocated)).toMatchObject({
    ok: true,
    value: { status: "retained" },
  });
  const manifest = await prepareActorRestoreManifest({
    env,
    relocationId: relocation.value.relocationId,
    now: Date.now(),
  });
  if (!manifest.ok) throw new Error(manifest.error.code);
  // The cell loses its Actor registry; the retained exports are the
  // recovery point, as in the existing restore journeys.
  await env.DB.prepare(
    "DELETE FROM state_object_relocation_item WHERE relocation_id = ?",
  )
    .bind(relocation.value.relocationId)
    .run();
  await fixtureDatabase()
    .prepare("DELETE FROM durable_object_registry WHERE organisation_id = ?")
    .bind(ORGANISATION_ID)
    .run();
  const restore = await startActorRestore({
    env,
    manifest: manifest.value,
    target: moveTarget(),
    now: Date.now(),
  });
  if (!restore.ok) throw new Error(restore.error.code);
  // A relocation cannot start while the restore holds the placement.
  const competing = await relocationRequest({
    command: "start",
    organisationId: ORGANISATION_ID,
    target: moveTarget(),
  });
  expect(competing.status, await competing.clone().text()).toBe(409);
  expect(await competing.json()).toMatchObject({
    error: { code: "placement_move_open" },
  });

  // Fault after the start checked the exports: one archive copy is damaged.
  const damagedKey = manifest.value.objects[0]?.exportRef.key;
  if (damagedKey === undefined) throw new Error("Empty restore manifest");
  const archived = await env.ARCHIVE.get(damagedKey);
  if (archived === null) throw new Error("Missing export archive");
  const archivedBytes = await archived.arrayBuffer();
  await env.ARCHIVE.put(damagedKey, "damaged export");
  const stopped = await restoreRequest({
    command: "resume",
    restoreId: restore.value.restoreId,
  });
  expect(stopped.ok, await stopped.clone().text()).toBe(false);
  const stoppedRestore = await restoreRequestGet(restore.value.restoreId);
  expect(["importing", "quarantined"]).toContain(
    stoppedRestore.inspection.restore.status,
  );
  // The source is frozen and the target reserved: no placement is active.
  expect(
    await OrganisationExecutionScope.resolve(env, ORGANISATION_ID),
  ).toMatchObject({ ok: false });

  const abandoned = await restoreRequest({
    command: "abandon",
    restoreId: restore.value.restoreId,
  });
  expect(abandoned.status, await abandoned.clone().text()).toBe(202);
  const abandonment = (await abandoned.json()) as {
    restore: { status: string; targetPlacementEpoch: number };
    recovery: { status: string; targetPlacementEpoch: number };
  };
  expect(abandonment).toMatchObject({
    restore: { status: "abandoned" },
    recovery: { status: "retained" },
  });
  const recovered = await requireOrganisationExecutionScope(
    env,
    ORGANISATION_ID,
  );
  expect(recovered.placement.placementEpoch).toBe(
    abandonment.recovery.targetPlacementEpoch,
  );
  expect(recovered.placement.placementCellId).toBe("e2e");
  // A repeat abandon changes nothing.
  const repeated = await restoreRequest({
    command: "abandon",
    restoreId: restore.value.restoreId,
  });
  expect(repeated.status, await repeated.clone().text()).toBe(202);
  expect(
    (await requireOrganisationExecutionScope(env, ORGANISATION_ID)).placement
      .placementEpoch,
  ).toBe(recovered.placement.placementEpoch);

  // The archive is repaired, and the operator restores again from the same
  // retained exports on top of the recovered placement.
  await env.ARCHIVE.put(damagedKey, archivedBytes);
  const retry = await restoreRequest({
    command: "start",
    manifest: manifest.value,
    target: moveTarget(),
  });
  expect(retry.status, await retry.clone().text()).toBe(202);
  const retried = (await retry.json()) as { restore: { restoreId: string } };
  const finished = await restoreRequest({
    command: "resume",
    restoreId: retried.restore.restoreId,
  });
  expect(finished.status, await finished.clone().text()).toBe(202);
  expect(await finished.json()).toMatchObject({
    restore: { status: "complete" },
  });
  const restored = await requireOrganisationExecutionScope(
    env,
    ORGANISATION_ID,
  );
  const restoredEntries = await placementEntries(
    restored.placement.placementEpoch,
  );
  expect(restoredEntries.map(entryIdentity)).toContain(`session:${sessionId}`);
  await requireActiveSessionActor({
    env,
    organisationId: ORGANISATION_ID,
    sessionId,
    now: Date.now(),
  });

  // The first relocation's source copy is cleaned: the abandoned restore and
  // the moves after it no longer hold the cleanup.
  const waived = await relocationRequest({
    command: "waive_retention",
    relocationId: relocation.value.relocationId,
    discardRecoveryCopy: true,
  });
  expect(waived.status, await waived.clone().text()).toBe(202);
  const cleaned = await relocationRequest({
    command: "resume",
    relocationId: relocation.value.relocationId,
  });
  expect(cleaned.status, await cleaned.clone().text()).toBe(202);
  expect(await cleaned.json()).toMatchObject({
    relocation: { status: "complete" },
  });

  Object.assign(task.meta, {
    placementMoveRestoreAbandon: {
      stoppedRestore: stoppedRestore.inspection.restore.status,
      competingRelocationRefused: "placement_move_open",
      abandonedRestore: "abandoned",
      recoveryRelocation: "retained",
      activePlacementAfterAbandon: recovered.placement.placementEpoch,
      retriedRestore: "complete",
      restoredPlacement: restored.placement.placementEpoch,
      firstRelocationCleanup: "complete",
    },
  });
}

it(
  "completes a relocation that leaves a quarantined Actor out and records a receipt for the operator",
  quarantinedActorJourney,
  100_000,
);

async function quarantinedActorJourney({ task }: TestContext): Promise<void> {
  await installDiscoveryActorFixture();
  const source = await requireOrganisationExecutionScope(env, ORGANISATION_ID);
  const movedId = sessionIdentity("session_moved_beside_quarantine");
  await requireActiveSessionActor({
    env,
    organisationId: ORGANISATION_ID,
    sessionId: movedId,
    now: Date.now(),
  });
  // An Actor whose activation conflicted is quarantined in the registry.
  const quarantinedId = sessionIdentity("session_quarantined_before_move");
  const reserved = await reserveActor({
    db: fixtureDatabase(),
    admission: await executionAdmission(source),
    identity: {
      objectKind: "session",
      organisationId: ORGANISATION_ID,
      logicalObjectId: quarantinedId,
    },
    schemaVersion: CANONICAL_SESSION_SCHEMA_VERSION,
    now: Date.now(),
  });
  if (!reserved.ok) throw new Error(reserved.error.code);
  const quarantined = await quarantineActorRegistryEntry({
    db: fixtureDatabase(),
    registryId: reserved.value.registryId,
    expectedFenceToken: reserved.value.fenceToken,
    reason: "activation_conflict_during_orphan_repair",
    now: Date.now(),
  });
  if (!quarantined.ok) throw new Error(quarantined.error.code);

  const started = await relocationRequest({
    command: "start",
    organisationId: ORGANISATION_ID,
    target: moveTarget(),
  });
  expect(started.status, await started.clone().text()).toBe(202);
  const relocationId = (
    (await started.json()) as {
      relocation: { relocationId: string };
    }
  ).relocation.relocationId;
  const moved = await relocationRequest({ command: "resume", relocationId });
  expect(moved.status, await moved.clone().text()).toBe(202);
  expect(await moved.json()).toMatchObject({
    relocation: { status: "retained" },
  });

  const inspected = await exports.default.fetch(
    new Request(
      `https://localhost/v1/admin/state-object-relocation?relocationId=${relocationId}`,
      { headers: adminHeaders() },
    ),
  );
  expect(inspected.status, await inspected.clone().text()).toBe(200);
  const inspection = (
    (await inspected.json()) as {
      inspection: {
        items: readonly { objectKind: string; logicalObjectId: string }[];
        exclusions: readonly {
          sourceRegistryId: string;
          objectKind: string;
          logicalObjectId: string;
          quarantineReason: string;
        }[];
      };
    }
  ).inspection;
  expect(inspection.exclusions).toEqual([
    expect.objectContaining({
      sourceRegistryId: reserved.value.registryId,
      objectKind: "session",
      logicalObjectId: quarantinedId,
      quarantineReason: "activation_conflict_during_orphan_repair",
    }),
  ]);
  expect(inspection.items.map(itemIdentity)).toContain(`session:${movedId}`);
  expect(inspection.items.map(itemIdentity)).not.toContain(
    `session:${quarantinedId}`,
  );
  const target = await requireOrganisationExecutionScope(env, ORGANISATION_ID);
  expect(target.placement.placementEpoch).toBeGreaterThan(
    source.placement.placementEpoch,
  );
  const targetEntries = await placementEntries(target.placement.placementEpoch);
  expect(targetEntries.map(entryIdentity)).toContain(`session:${movedId}`);
  expect(targetEntries.map(entryIdentity)).not.toContain(
    `session:${quarantinedId}`,
  );
  // The quarantined entry stays at the source epoch, as the receipt says.
  expect(
    (await placementEntries(source.placement.placementEpoch)).find(
      (entry) => entry.registryId === reserved.value.registryId,
    ),
  ).toMatchObject({ lifecycleStatus: "quarantined" });
  await requireActiveSessionActor({
    env,
    organisationId: ORGANISATION_ID,
    sessionId: movedId,
    now: Date.now(),
  });

  Object.assign(task.meta, {
    placementMoveQuarantinedActor: {
      relocation: "retained",
      exclusions: inspection.exclusions.length,
      exclusionReason: "activation_conflict_during_orphan_repair",
      movedActorActive: true,
    },
  });
}

it(
  "lets a relocation freeze after the 15-minute run reconciles a stale Actor reservation",
  staleReservationJourney,
  100_000,
);

async function staleReservationJourney({ task }: TestContext): Promise<void> {
  await installDiscoveryActorFixture();
  const source = await requireOrganisationExecutionScope(env, ORGANISATION_ID);
  const started = await relocationRequest({
    command: "start",
    organisationId: ORGANISATION_ID,
    target: moveTarget(),
  });
  expect(started.status, await started.clone().text()).toBe(202);
  const relocationId = (
    (await started.json()) as {
      relocation: { relocationId: string };
    }
  ).relocation.relocationId;
  // A request stopped after it reserved this Actor and before it activated
  // it. The reservation holds the source's freeze.
  const staleId = sessionIdentity("session_stale_reservation");
  const reserved = await reserveActor({
    db: fixtureDatabase(),
    admission: await executionAdmission(source),
    identity: {
      objectKind: "session",
      organisationId: ORGANISATION_ID,
      logicalObjectId: staleId,
    },
    schemaVersion: CANONICAL_SESSION_SCHEMA_VERSION,
    now: Date.now(),
  });
  if (!reserved.ok) throw new Error(reserved.error.code);
  const refused = await relocationRequest({ command: "resume", relocationId });
  expect(refused.status, await refused.clone().text()).toBe(409);
  expect(await refused.json()).toMatchObject({
    error: { code: "organisation_placement_move_conflict" },
  });

  // The 15-minute run, one period after the reservation.
  const scheduledTime = Date.now() + 16 * 60_000;
  const context = createExecutionContext();
  gateway.scheduled(
    createScheduledController({ cron: "*/15 * * * *", scheduledTime }),
    env,
    context,
  );
  await waitOnExecutionContext(context);
  const reconciled = (await placementEntries(source.placement.placementEpoch))
    .filter((entry) => entry.registryId === reserved.value.registryId)
    .map((entry) => entry.lifecycleStatus);
  expect(reconciled).toEqual(["active"]);

  const moved = await relocationRequest({ command: "resume", relocationId });
  expect(moved.status, await moved.clone().text()).toBe(202);
  expect(await moved.json()).toMatchObject({
    relocation: { status: "retained" },
  });
  const target = await requireOrganisationExecutionScope(env, ORGANISATION_ID);
  const targetEntries = await placementEntries(target.placement.placementEpoch);
  expect(targetEntries.map(entryIdentity)).toContain(`session:${staleId}`);

  Object.assign(task.meta, {
    placementMoveStaleReservation: {
      freezeBeforeRun: "organisation_placement_move_conflict",
      reservationAfterRun: "active",
      relocation: "retained",
    },
  });
}

function sessionIdentity(value: string): SessionId {
  const parsed = parseSessionId(value);
  if (!parsed.ok) throw new Error("Invalid Session identity");
  return parsed.value;
}

async function executionAdmission(scope: OrganisationExecutionScope) {
  const admission = await resolveActorExecutionAdmission(
    env.DB,
    ORGANISATION_ID,
    scope.placement,
  );
  if (!admission.ok) throw new Error(admission.error.code);
  return admission.value;
}

function entryIdentity(entry: {
  readonly identity: {
    readonly objectKind: string;
    readonly logicalObjectId: string;
  };
}): string {
  return `${entry.identity.objectKind}:${entry.identity.logicalObjectId}`;
}

function itemIdentity(item: {
  readonly objectKind: string;
  readonly logicalObjectId: string;
}): string {
  return `${item.objectKind}:${item.logicalObjectId}`;
}

function adminHeaders(): HeadersInit {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${env.ORGANISATION_ADMIN_TOKEN}`,
  };
}

function relocationRequest(body: Record<string, unknown>): Promise<Response> {
  return exports.default.fetch(
    new Request("https://localhost/v1/admin/state-object-relocation", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify(body),
    }),
  );
}

function restoreRequest(body: Record<string, unknown>): Promise<Response> {
  return exports.default.fetch(
    new Request("https://localhost/v1/admin/state-object-restore", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify(body),
    }),
  );
}

async function restoreRequestGet(
  restoreId: string,
): Promise<{ inspection: { restore: { status: string } } }> {
  const response = await exports.default.fetch(
    new Request(
      `https://localhost/v1/admin/state-object-restore?restoreId=${restoreId}`,
      { headers: adminHeaders() },
    ),
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as {
    inspection: { restore: { status: string } };
  };
}
