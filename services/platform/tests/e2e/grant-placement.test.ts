import { env } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { expect, it, vi, type TestContext } from "vitest";
import {
  createVersionedAccessGrant,
  revokeVersionedAccessGrant,
} from "../../src/access-control/grant-mutations";
import { readAccessGrant } from "../../src/data/access-grants";
import { readControlMutationReplay } from "@purin-labs/tenancy/data/control-mutation";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { parseUserId, type UserId } from "@purin-labs/control-api/ids";
import { parseOrganisationPlacementMoveTarget } from "@purin-labs/tenancy/data/organisation-placement";
import {
  startActorRelocation,
  resumeActorRelocation,
  type ActorRelocationId,
} from "@purin-labs/actor-runtime/actors/actor-relocation";
import {
  installDiscoveryActorFixture,
  ORGANISATION_ID,
  OTHER_ORGANISATION_ID,
} from "./slack-journey-support";

const isScopeActive = OrganisationExecutionScope.prototype.isActive;
type Race = { relocationId: ActorRelocationId | null };

it(
  "settles grants atomically across cleanup failure, freeze and relocation",
  grantPlacementJourney,
  90_000,
);

async function grantPlacementJourney({ task }: TestContext) {
  await installDiscoveryActorFixture();
  const operator = await operatorId();
  const source = await currentScope();
  const supplier = await readAccessGrant({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    grantId: "grant_e2e_supplier_file",
  });
  if (!supplier.ok) throw new Error(supplier.error.code);
  const otherBefore = await organisationEvidence(OTHER_ORGANISATION_ID);
  const initialRevision = await revision();
  const create = {
    scope: source,
    grantId: "grant_plan55_file",
    expectedProjectionRevision: initialRevision,
    subject: supplier.value.subject,
    target: supplier.value.target,
    actorUserId: operator,
    ...settlement("create"),
  };
  const created = await createVersionedAccessGrant(create);
  expect(created).toMatchObject({
    ok: true,
    value: {
      projectionRevision: initialRevision + 1,
      grant: { lifecycle: { kind: "active", revision: 1 } },
    },
  });
  expect(await grantSyncCount(create.grantId)).toBe(1);
  expect(
    await receiptReplay(operator, "create", create.grantId, create.boundary),
  ).toMatchObject({
    kind: "replay",
    receipt: {
      responseStatus: 200,
      responseBody: { grant: { grantId: create.grantId } },
    },
  });
  expect(await createVersionedAccessGrant(create)).toMatchObject({
    ok: true,
    value: { recovered: true },
  });
  const afterCreate = await organisationEvidence(ORGANISATION_ID);
  expect(
    await createVersionedAccessGrant({
      ...create,
      grantId: "grant_plan55_stale",
      ...settlement("stale_create"),
    }),
  ).toMatchObject({
    ok: false,
    error: { code: "access_control_revision_conflict" },
  });
  expect(await organisationEvidence(ORGANISATION_ID)).toEqual(afterCreate);

  const revoke = {
    scope: source,
    grantId: supplier.value.grantId,
    expectedProjectionRevision: initialRevision + 1,
    expectedGrantRevision: 1,
    actorUserId: operator,
    reason: "Operator removed file access",
    ...settlement("revoke_supplier"),
  };
  const beforeCleanup = await organisationEvidence(ORGANISATION_ID);
  await fixtureDatabase()
    .prepare(
      `CREATE TRIGGER grant_cleanup_failure BEFORE UPDATE ON context_projection
    WHEN NEW.superseded_reason = 'grant_revoked'
    BEGIN SELECT RAISE(ABORT, 'grant_cleanup_failure'); END`,
    )
    .run();
  try {
    expect(await revokeVersionedAccessGrant(revoke)).toMatchObject({
      ok: false,
      error: { code: "access_grant_mutation_failed" },
    });
  } finally {
    await fixtureDatabase().prepare("DROP TRIGGER grant_cleanup_failure").run();
  }
  expect(await organisationEvidence(ORGANISATION_ID)).toEqual(beforeCleanup);
  expect(
    await receiptReplay(operator, "revoke", revoke.grantId, revoke.boundary),
  ).toEqual({ kind: "absent" });
  const revoked = await revokeVersionedAccessGrant(revoke);
  expect(revoked).toMatchObject({
    ok: true,
    value: {
      projectionRevision: initialRevision + 2,
      grant: { lifecycle: { kind: "revoked", revision: 2 } },
    },
  });
  expect(await grantSyncCount(revoke.grantId)).toBe(0);
  expect(
    await fixtureDatabase()
      .prepare(
        "SELECT count(*) AS count FROM file_grant_admission WHERE organisation_id = ? AND grant_id = ?",
      )
      .bind(ORGANISATION_ID, revoke.grantId)
      .first(),
  ).toEqual({ count: 0 });
  expect(
    await fixtureDatabase()
      .prepare(
        "SELECT lifecycle, superseded_reason FROM context_projection WHERE organisation_id = ? AND source_kind = 'file_segment'",
      )
      .bind(ORGANISATION_ID)
      .first(),
  ).toEqual({ lifecycle: "superseded", superseded_reason: "grant_revoked" });
  expect(
    await receiptReplay(operator, "revoke", revoke.grantId, revoke.boundary),
  ).toMatchObject({
    kind: "replay",
    receipt: { responseBody: { grant: { lifecycle: { kind: "revoked" } } } },
  });
  expect(await revokeVersionedAccessGrant(revoke)).toMatchObject({
    ok: true,
    value: { recovered: true },
  });
  const afterRevoke = await organisationEvidence(ORGANISATION_ID);
  expect(
    await revokeVersionedAccessGrant({
      ...revoke,
      ...settlement("distinct_revoke"),
    }),
  ).toMatchObject({
    ok: false,
    error: { code: "access_control_revision_conflict" },
  });
  expect(await organisationEvidence(ORGANISATION_ID)).toEqual(afterRevoke);

  const race: Race = { relocationId: null };
  const pause = vi
    .spyOn(OrganisationExecutionScope.prototype, "isActive")
    .mockImplementationOnce(
      freezeAfterCheck.bind(null, source, race, "e2e-cleanup-live"),
    );
  try {
    expect(
      await createVersionedAccessGrant({
        ...create,
        grantId: "grant_plan55_frozen",
        expectedProjectionRevision: initialRevision + 2,
        ...settlement("frozen_create"),
      }),
    ).toMatchObject({ ok: false });
    expect(pause).toHaveBeenCalled();
  } finally {
    pause.mockRestore();
  }
  expect(await organisationEvidence(ORGANISATION_ID)).toEqual(afterRevoke);
  await recover(race);
  expect(
    await createVersionedAccessGrant({
      ...create,
      grantId: "grant_plan55_retired",
      expectedProjectionRevision: initialRevision + 2,
      ...settlement("retired_create"),
    }),
  ).toMatchObject({
    ok: false,
    error: { code: "access_grant_mutation_failed" },
  });
  const target = await currentScope();
  const targetRevoke = {
    ...revoke,
    scope: target,
    grantId: create.grantId,
    expectedProjectionRevision: initialRevision + 2,
    ...settlement("target_revoke"),
  };
  const revokeRace: Race = { relocationId: null };
  const revokePause = vi
    .spyOn(OrganisationExecutionScope.prototype, "isActive")
    .mockImplementationOnce(
      freezeAfterCheck.bind(null, target, revokeRace, "e2e-cleanup-recovery"),
    );
  try {
    expect(await revokeVersionedAccessGrant(targetRevoke)).toMatchObject({
      ok: false,
    });
  } finally {
    revokePause.mockRestore();
  }
  expect(await organisationEvidence(ORGANISATION_ID)).toEqual(afterRevoke);
  await recover(revokeRace);
  expect(
    await revokeVersionedAccessGrant({
      ...targetRevoke,
      scope: await currentScope(),
    }),
  ).toMatchObject({
    ok: true,
    value: { projectionRevision: initialRevision + 3 },
  });
  expect(await grantSyncCount(create.grantId)).toBe(0);
  expect(await organisationEvidence(OTHER_ORGANISATION_ID)).toEqual(
    otherBefore,
  );
  Object.assign(task.meta, {
    grantPlacementEvidence: {
      create:
        "grant, file sync, revision, receipt and audit committed together",
      replay:
        "committed create and revoke replay; stale distinct operations have no effects",
      cleanupFailure:
        "projection failure rolls back revocation, cleanup, revision, receipt and audit",
      freeze:
        "create and revoke rejected after active-scope check; no dependent writes",
      recovery:
        "retired scope rejected; fresh scope completed revocation after two relocations",
      isolation: "other organisation unchanged",
      final: await organisationEvidence(ORGANISATION_ID),
    },
  });
}

function settlement(name: string) {
  return {
    boundary: {
      kind: "unversioned" as const,
      idempotencyKey: `p55_grant_${name}`,
      requestHash: `p55_grant_${name}`,
    },
    identity: {
      receiptId: `receipt_p55_grant_${name}`,
      auditEventId: `audit_p55_grant_${name}`,
      correlationId: "p55_grant",
      causationId: "p55_grant",
      portalSubjectHash: "p55_grant",
      createdAt: Date.now(),
    },
  };
}
async function currentScope() {
  const resolved = await OrganisationExecutionScope.resolve(
    env,
    ORGANISATION_ID,
  );
  if (!resolved.ok) throw new Error(resolved.error.code);
  return resolved.value;
}
async function operatorId() {
  const parsed = parseUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab");
  if (!parsed.ok) throw new Error(parsed.error.code);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO app_user (user_id, issuer, subject, email, display_name, email_verified, created_at, last_authenticated_at)
    VALUES (?, 'https://e2e.example', 'p55-grants', 'grants@example.test', 'Grant operator', 1, ?, ?)`,
  )
    .bind(parsed.value, Date.now(), Date.now())
    .run();
  return parsed.value;
}
async function revision() {
  const row = await fixtureDatabase()
    .prepare(
      "SELECT projection_revision FROM organisation_onboarding WHERE organisation_id = ?",
    )
    .bind(ORGANISATION_ID)
    .first<{ projection_revision: number }>();
  if (!row) throw new Error("Missing onboarding state");
  return row.projection_revision;
}
async function grantSyncCount(grantId: string) {
  return (
    await fixtureDatabase()
      .prepare(
        "SELECT count(*) AS count FROM file_grant_sync WHERE organisation_id = ? AND grant_id = ?",
      )
      .bind(ORGANISATION_ID, grantId)
      .first<{ count: number }>()
  )?.count;
}
function receiptReplay(
  userId: UserId,
  operation: "create" | "revoke",
  grantId: string,
  boundary: ReturnType<typeof settlement>["boundary"],
) {
  const base = `/v1/control/organisations/${ORGANISATION_ID}/access-control/grants`;
  return readControlMutationReplay({
    db: fixtureDatabase(),
    scope: {
      userId,
      organisationScope: ORGANISATION_ID,
      route: operation === "create" ? base : `${base}/${grantId}/revoke`,
      operation: `access_control.grant.${operation}`,
    },
    boundary,
  });
}
async function organisationEvidence(organisationId: typeof ORGANISATION_ID) {
  const [grants, onboarding, receipts, audits, admissions, sync, projections] =
    await fixtureDatabase().batch([
      fixtureDatabase()
        .prepare(
          "SELECT grant_id, lifecycle, revision, provenance_json FROM access_grant WHERE organisation_id = ? ORDER BY grant_id",
        )
        .bind(organisationId),
      fixtureDatabase()
        .prepare(
          "SELECT configuration_version, projection_revision FROM organisation_onboarding WHERE organisation_id = ?",
        )
        .bind(organisationId),
      fixtureDatabase()
        .prepare(
          "SELECT receipt_id FROM control_mutation_receipt WHERE organisation_scope = ? ORDER BY receipt_id",
        )
        .bind(organisationId),
      fixtureDatabase()
        .prepare(
          "SELECT audit_event_id FROM onboarding_audit_event WHERE organisation_id = ? ORDER BY audit_event_id",
        )
        .bind(organisationId),
      fixtureDatabase()
        .prepare(
          "SELECT grant_id, provider_file_id FROM file_grant_admission WHERE organisation_id = ? ORDER BY grant_id, provider_file_id",
        )
        .bind(organisationId),
      fixtureDatabase()
        .prepare(
          "SELECT grant_id, state FROM file_grant_sync WHERE organisation_id = ? ORDER BY grant_id",
        )
        .bind(organisationId),
      fixtureDatabase()
        .prepare(
          "SELECT source_key, lifecycle, superseded_reason FROM context_projection WHERE organisation_id = ? ORDER BY source_key",
        )
        .bind(organisationId),
    ]);
  return {
    grants: statementRows(grants),
    onboarding: statementRows(onboarding),
    receipts: statementRows(receipts),
    audits: statementRows(audits),
    admissions: statementRows(admissions),
    sync: statementRows(sync),
    projections: statementRows(projections),
  };
}
function statementRows(result: D1Result | undefined) {
  if (!result) throw new Error("Missing evidence query result");
  return result.results;
}
async function freezeAfterCheck(
  scope: OrganisationExecutionScope,
  race: Race,
  placementCellId: "e2e-cleanup-live" | "e2e-cleanup-recovery",
) {
  const active = await isScopeActive.call(scope);
  expect(active).toBe(true);
  const target = parseOrganisationPlacementMoveTarget({
    kind: "affinity",
    // Each move needs a fresh cell while prior source data remains retained.
    placementCellId,
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
    `CREATE TRIGGER grant_race_hold BEFORE UPDATE OF status ON state_object_relocation
    WHEN NEW.status = 'published' BEGIN SELECT RAISE(ABORT, 'grant_race_hold'); END`,
  ).run();
  await expect(
    resumeActorRelocation({
      env,
      relocationId: move.value.relocationId,
      now: Date.now(),
    }),
  ).rejects.toThrow("grant_race_hold");
  return active;
}
async function recover(race: Race) {
  if (race.relocationId === null) throw new Error("Placement was not frozen");
  await env.DB.prepare("DROP TRIGGER grant_race_hold").run();
  expect(
    await resumeActorRelocation({
      env,
      relocationId: race.relocationId,
      now: Date.now(),
    }),
  ).toMatchObject({ ok: true, value: { status: "retained" } });
}
