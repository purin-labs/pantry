import { env } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { evictDurableObject } from "cloudflare:test";
import { expect, it, type TestContext } from "vitest";
import {
  installSlackActorFixture,
  ORGANISATION_ID,
} from "./slack-journey-support";
import { issueControlSession } from "../../src/data/control-plane";
import { parseUserId } from "../../src/ids";
import { authorizeOrganisationRequest } from "../../src/control/authorization";
import { recordCommerceMutationReceipt } from "../../src/control/mutation-receipt";
import { readControlMutationReplay } from "../../src/data/control-mutation";
import { requireActiveOrganisationActor } from "../../src/actors/actor-router";
import {
  startActorRelocation,
  resumeActorRelocation,
} from "../../src/actors/actor-relocation";
import { parseOrganisationPlacementMoveTarget } from "../../src/data/organisation-placement";

type DigestPause = {
  phase: "armed" | "paused" | "released";
  digest: SubtleCrypto["digest"];
};
let pause: DigestPause | null = null;

it(
  "rejects a paused control receipt across relocation and preserves fresh replay after eviction",
  { timeout: 60_000 },
  receiptRelocationJourney,
);

async function receiptRelocationJourney({ task }: TestContext) {
  await installSlackActorFixture();
  const userId = parseUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab");
  if (!userId.ok) throw new Error("Invalid control user");
  await fixtureDatabase()
    .prepare(
      "UPDATE service_role_grant SET role = 'admin' WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(ORGANISATION_ID, userId.value)
    .run();
  const session = await issueControlSession({
    db: env.DB,
    userId: userId.value,
    now: Date.now(),
    ttlMs: 600_000,
  });
  const request = new Request(
    `${env.PANTRY_PUBLIC_ORIGIN}/control/organisations/${ORGANISATION_ID}/receipt`,
    {
      method: "POST",
      headers: {
        origin: env.PANTRY_PUBLIC_ORIGIN,
        cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
        "x-satyr-csrf": session.csrfToken,
      },
    },
  );
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    ORGANISATION_ID,
    "admin",
    true,
  );
  if (!authorized.ok) throw new Error(await authorized.response.text());
  const source = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const input = {
    authorized,
    identity: {
      issuer: "control-receipt-fixture",
      subject: userId.value,
      userId: userId.value,
    },
    scope: {
      userId: userId.value,
      organisationScope: ORGANISATION_ID,
      route: "receipt-relocation",
      operation: "record",
    },
    boundary: {
      kind: "unversioned" as const,
      idempotencyKey: "receipt-relocation",
      requestHash: "receipt-request",
    },
    request,
    responseBody: { ok: true, receipt: "accepted" },
    now: Date.now(),
  };
  const probe: DigestPause = { phase: "armed", digest: crypto.subtle.digest };
  pause = probe;
  crypto.subtle.digest = pauseReceiptDigest;
  const work = recordCommerceMutationReceipt(input);
  try {
    await expect.poll(receiptPausePhase.bind(null, probe)).toBe("paused");
    const target = parseOrganisationPlacementMoveTarget({
      kind: "affinity",
      placementCellId: "e2e",
      locationHint: "wnam",
    });
    if (!target.ok) throw new Error(target.error.code);
    const started = await startActorRelocation({
      env,
      organisationId: ORGANISATION_ID,
      target: target.value,
      now: Date.now(),
    });
    if (!started.ok) throw new Error(started.error.code);
    expect(
      await resumeActorRelocation({
        env,
        relocationId: started.value.relocationId,
        now: Date.now(),
      }),
    ).toMatchObject({ ok: true, value: { status: "retained" } });
    probe.phase = "released";
    expect(await work).toEqual({
      ok: false,
      error: { code: "organisation_placement_conflict" },
    });
  } finally {
    probe.phase = "released";
    crypto.subtle.digest = probe.digest;
    pause = null;
  }
  expect(
    await readControlMutationReplay({
      db: fixtureDatabase(),
      scope: input.scope,
      boundary: input.boundary,
    }),
  ).toEqual({ kind: "absent" });
  await evictDurableObject(source);
  expect(await recordCommerceMutationReceipt(input)).toEqual({
    ok: false,
    error: { code: "organisation_placement_conflict" },
  });
  const fresh = await authorizeOrganisationRequest(
    request,
    env,
    ORGANISATION_ID,
    "admin",
    true,
  );
  if (!fresh.ok) throw new Error(await fresh.response.text());
  expect(fresh.executionScope.placement.placementEpoch).toBeGreaterThan(
    authorized.executionScope.placement.placementEpoch,
  );
  expect(
    await recordCommerceMutationReceipt({ ...input, authorized: fresh }),
  ).toEqual({ ok: true, value: null });
  const targetActor = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  await evictDurableObject(targetActor);
  expect(
    await readControlMutationReplay({
      db: fresh.executionScope.database,
      scope: input.scope,
      boundary: input.boundary,
    }),
  ).toEqual({
    kind: "replay",
    receipt: { responseStatus: 200, responseBody: input.responseBody },
  });
  const count = await fixtureDatabase()
    .prepare(
      "SELECT COUNT(*) AS count FROM control_mutation_receipt WHERE organisation_scope = ? AND route = ?",
    )
    .bind(ORGANISATION_ID, input.scope.route)
    .first<{ count: number }>();
  expect(count?.count).toBe(1);
  Object.assign(task.meta, {
    controlReceiptPlacement: {
      sourceEpoch: authorized.executionScope.placement.placementEpoch,
      targetEpoch: fresh.executionScope.placement.placementEpoch,
      staleReceipt: "denied",
      freshReceiptCount: count?.count,
      replayAfterEviction: "exact",
      databaseTopology: "single-store",
    },
  });
}

function receiptPausePhase(probe: DigestPause) {
  return probe.phase;
}

async function pauseReceiptDigest(
  this: SubtleCrypto,
  algorithm: Parameters<SubtleCrypto["digest"]>[0],
  data: Parameters<SubtleCrypto["digest"]>[1],
): Promise<ArrayBuffer> {
  const probe = pause;
  if (probe === null) throw new Error("Missing receipt pause");
  const result = await probe.digest.call(this, algorithm, data);
  if (probe.phase === "armed") {
    probe.phase = "paused";
    while (probe.phase === "paused") await scheduler.wait(5);
  }
  return result;
}
