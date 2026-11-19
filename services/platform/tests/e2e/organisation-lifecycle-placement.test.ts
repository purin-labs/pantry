import {
  interceptPlacementSession,
  completeRetainedPlacement,
  type PlacementRace,
} from "./placement-race-support";
import { organisationDatabase, fixtureDatabase, onboardFixtureOrganisation } from "./organisation-database";
import { env, exports } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { assertNever } from "@purin-labs/std";
import { parseUserId, type UserId, type OrganisationId } from "../../src/ids";
import {
  issueControlSession,
  type IssuedControlSession,
} from "../../src/data/control-plane";
import { newControlMutationIdentity } from "../../src/data/control-mutation";
import {
  archiveOrganisation,
  deleteArchivedOrganisation,
  renameOrganisation,
  restoreOrganisation,
  type ArchiveOrganisationMutation,
} from "../../src/data/organisation-lifecycle";
import { createOrganisationInstall } from "../../src/data/organisation";
import { OrganisationExecutionScope } from "../../src/organisation-execution-scope";
import { requireActiveOrganisationActor } from "../../src/actors/actor-router";
import {
  ORGANISATION_ID,
  OTHER_WORKSPACE_ID,
  installSlackActorFixture,
  requiredPlacement,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    lifecyclePlacement?: Record<string, unknown>;
  }
}

type LifecycleOperation = "rename" | "archive" | "restore" | "delete";
type LifecycleRequest = {
  execution: OrganisationExecutionScope;
  userId: UserId;
  operation: LifecycleOperation;
  mutation: ArchiveOrganisationMutation;
};

it(
  "fences organisation lifecycle commits across real relocation, rolls back late failures and retries through HTTP",
  lifecycleJourney,
  100_000,
);

async function lifecycleJourney({ task }: import("vitest").TestContext) {
  await installSlackActorFixture();
  const parsed = parseUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab");
  if (!parsed.ok) throw new Error(parsed.error.code);
  const userId = parsed.value;
  await fixtureDatabase().prepare(
    "UPDATE service_role_grant SET role = 'owner' WHERE organisation_id = ? AND user_id = ?",
  )
    .bind(ORGANISATION_ID, userId)
    .run();
  const session = await issueControlSession({
    db: env.DB,
    userId,
    now: Date.now(),
    ttlMs: 1_800_000,
  });
  await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  // The other bakery onboards in the Portal, then installs Slack.
  const { organisationId: otherOrganisationId } =
    await onboardFixtureOrganisation("Independent bakery");
  await createOrganisationInstall(organisationDatabase(otherOrganisationId), env.DB, {
    organisationId: otherOrganisationId,
    name: "Independent bakery",
    surfaceKind: "slack",
    workspaceId: OTHER_WORKSPACE_ID,
    installModel: "unlisted",
    botTokenRef: "vault:slack:bot:lifecycle-other",
    scopes: ["chat:write"],
    placement: requiredPlacement(),
    createdAt: Date.now() - 2000,
    installedAt: Date.now() - 1000,
  });
  await fixtureDatabase().batch([
    fixtureDatabase().prepare(
      `INSERT INTO project
      (organisation_id, user_id, project_id, access_kind, access_revision, name, brief,
       references_json, revision, content_revision, created_at, updated_at)
      VALUES (?, NULL, 'project_lifecycle', 'shared', 1, 'Bakery handover', '', '[]', 1, 1, ?, ?)`,
    ).bind(ORGANISATION_ID, Date.now(), Date.now()),
    fixtureDatabase().prepare(
      `INSERT INTO project_member
      (organisation_id, project_id, user_id, role) VALUES (?, 'project_lifecycle', ?, 'owner')`,
    ).bind(ORGANISATION_ID, userId),
  ]);
  const otherBefore = await lifecycleRows(otherOrganisationId);
  const projectsBefore = (await lifecycleRows(ORGANISATION_ID)).project;
  const evidence = [];
  for (const operation of [
    "rename",
    "archive",
    "restore",
    "delete",
  ] satisfies LifecycleOperation[]) {
    if (operation === "delete") {
      await submitLifecycle(
        session,
        "archive",
        "lifecycle-second-archive",
        await configurationVersion(),
      );
    }
    const execution = await executionScope();
    const version = await configurationVersion();
    const idempotencyKey = `lifecycle-${operation}`;
    const request: LifecycleRequest = {
      execution,
      userId,
      operation,
      mutation: {
        boundary: {
          kind: "configuration_versioned",
          expectedConfigurationVersion: version,
          idempotencyKey,
          requestHash: `uncommitted-${operation}`,
        },
        scope: {
          userId,
          organisationScope: ORGANISATION_ID,
          route: lifecycleRoute(operation),
          operation: `organisation.${operation}`,
        },
        identity: newControlMutationIdentity({
          portalSubjectHash: "lifecycle-owner",
          causationId: idempotencyKey,
          now: Date.now(),
        }),
      },
    };
    const before = await lifecycleRows(ORGANISATION_ID);
    const race: PlacementRace = {
      organisationId: ORGANISATION_ID,
      phase: { kind: "waiting" },
    };
    const withSession = fixtureDatabase().withSession.bind(fixtureDatabase());
    const intercepted = vi
      .spyOn(fixtureDatabase(), "withSession")
      .mockImplementation(
        interceptPlacementSession.bind(null, race, withSession),
      );
    try {
      expect(await invokeLifecycle(request)).toEqual({
        ok: false,
        error: { code: "organisation_placement_conflict" },
      });
      expect(race.phase.kind).toBe("frozen");
      expect(await lifecycleRows(ORGANISATION_ID)).toEqual(before);
    } finally {
      intercepted.mockRestore();
      await env.DB.prepare(
        "DROP TRIGGER IF EXISTS lifecycle_interrupt_publication",
      ).run();
    }
    if (race.phase.kind !== "frozen")
      throw new Error("Lifecycle request never reached its commit boundary");
    const relocationId = race.phase.relocationId;
    await completeRetainedPlacement(relocationId);
    expect(await invokeLifecycle(request)).toEqual({
      ok: false,
      error: { code: "organisation_placement_conflict" },
    });
    expect(await lifecycleRows(ORGANISATION_ID)).toEqual(before);
    if (operation === "delete") {
      await fixtureDatabase().prepare(
        `CREATE TRIGGER lifecycle_fail_membership
        BEFORE DELETE ON service_role_grant WHEN OLD.organisation_id = '${ORGANISATION_ID}'
        BEGIN SELECT RAISE(ABORT, 'lifecycle_late_write_failed'); END`,
      ).run();
      try {
        const failed = await submitLifecycleResponse(
          session,
          operation,
          idempotencyKey,
          version,
        );
        expect(failed.status).toBe(500);
        expect(await lifecycleRows(ORGANISATION_ID)).toEqual(before);
      } finally {
        await fixtureDatabase().prepare("DROP TRIGGER lifecycle_fail_membership").run();
      }
    }
    const response = await submitLifecycle(
      session,
      operation,
      idempotencyKey,
      version,
    );
    if (operation !== "delete") {
      expect(
        await submitLifecycle(session, operation, idempotencyKey, version),
      ).toEqual(response);
    }
    expect(
      await fixtureDatabase().prepare(
        "SELECT COUNT(*) AS count FROM control_mutation_receipt WHERE organisation_scope = ? AND idempotency_key = ?",
      )
        .bind(ORGANISATION_ID, idempotencyKey)
        .first("count"),
    ).toBe(1);
    expect(
      await fixtureDatabase().prepare(
        "SELECT COUNT(*) AS count FROM onboarding_audit_event WHERE organisation_id = ? AND operation = ?",
      )
        .bind(ORGANISATION_ID, `organisation.${operation}`)
        .first("count"),
    ).toBe(1);
    expect(await configurationVersion()).toBe(version + 1);
    evidence.push({
      operation,
      relocationId,
      frozenRequest: "rejected_without_writes",
      retiredRequest: "rejected_without_writes",
      freshHttpStatus: 200,
      receiptCount: 1,
      replay: operation === "delete" ? "membership_removed" : "same_receipt",
    });
  }
  expect(await lifecycleRows(otherOrganisationId)).toEqual(otherBefore);
  expect(
    await fixtureDatabase().prepare(
      "SELECT COUNT(*) AS count FROM service_role_grant WHERE organisation_id = ?",
    )
      .bind(ORGANISATION_ID)
      .first("count"),
  ).toBe(0);
  expect(
    await fixtureDatabase().prepare(
      "SELECT COUNT(*) AS count FROM project_member WHERE organisation_id = ?",
    )
      .bind(ORGANISATION_ID)
      .first("count"),
  ).toBe(0);
  expect((await lifecycleRows(ORGANISATION_ID)).project).toEqual(
    projectsBefore,
  );
  expect(
    (await env.DB.prepare("PRAGMA foreign_key_check").all()).results,
  ).toEqual([]);
  task.meta.lifecyclePlacement = {
    operations: evidence,
    lateDeleteFailure: "all_writes_and_receipt_rolled_back",
    otherOrganisation: "unchanged",
    projectContent: "retained_for_archive_purge",
    foreignKeyViolations: 0,
  };
}

function invokeLifecycle(request: LifecycleRequest) {
  const input = {
    directory: env.DB,
    execution: request.execution,
    actorUserId: request.userId,
    mutation: request.mutation,
    now: Date.now(),
  };
  switch (request.operation) {
    case "rename":
      return renameOrganisation({ ...input, name: "Lifecycle bakery" });
    case "archive":
      return archiveOrganisation({
        identityDatabase: env.DB,
        ...input,
        authority: { kind: "organisation_owner" },
        reasonCode: "merchant_archived",
      });
    case "restore":
      return restoreOrganisation(input);
    case "delete":
      return deleteArchivedOrganisation(input);
    default:
      return assertNever(request.operation);
  }
}

async function configurationVersion(): Promise<number> {
  const version = await fixtureDatabase().prepare(
    "SELECT configuration_version FROM organisation_onboarding WHERE organisation_id = ?",
  )
    .bind(ORGANISATION_ID)
    .first<number>("configuration_version");
  if (version === null) throw new Error("Missing organisation lifecycle");
  return version;
}

async function executionScope() {
  const result = await OrganisationExecutionScope.resolve(env, ORGANISATION_ID);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function lifecycleRoute(operation: LifecycleOperation) {
  return `/v1/control/organisations/${ORGANISATION_ID}${operation === "archive" || operation === "restore" ? `/${operation}` : ""}`;
}

function lifecycleMethod(operation: LifecycleOperation) {
  switch (operation) {
    case "rename":
      return "PATCH";
    case "delete":
      return "DELETE";
    case "archive":
    case "restore":
      return "POST";
    default:
      return assertNever(operation);
  }
}

function submitLifecycleResponse(
  session: IssuedControlSession,
  operation: LifecycleOperation,
  idempotencyKey: string,
  version: number,
) {
  return exports.default.fetch(
    `https://localhost${lifecycleRoute(operation)}`,
    {
      method: lifecycleMethod(operation),
      headers: {
        cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
        origin: "https://localhost",
        "content-type": "application/json",
        "x-satyr-csrf": session.csrfToken,
        "x-satyr-configuration-version": String(version),
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(
        operation === "rename" ? { name: "Lifecycle bakery" } : {},
      ),
    },
  );
}

async function submitLifecycle(
  session: IssuedControlSession,
  operation: LifecycleOperation,
  idempotencyKey: string,
  version: number,
): Promise<unknown> {
  const response = await submitLifecycleResponse(
    session,
    operation,
    idempotencyKey,
    version,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}

async function lifecycleRows(organisationId: OrganisationId) {
  const snapshot: Record<string, unknown> = {};
  for (const table of [
    "organisation",
    "organisation_onboarding",
    "integration_account",
    "provider_connection",
    "service_role_grant",
    "organisation_archive_cleanup",
    "organisation_archive_tombstone",
    "onboarding_audit_event",
    "onboarding_event",
    "project",
    "project_member",
  ]) {
    snapshot[table] = (
      await fixtureDatabase().prepare(
        `SELECT * FROM ${table} WHERE organisation_id = ? ORDER BY rowid`,
      )
        .bind(organisationId)
        .all()
    ).results;
  }
  snapshot.receipts = (
    await fixtureDatabase().prepare(
      "SELECT * FROM control_mutation_receipt WHERE organisation_scope = ? ORDER BY rowid",
    )
      .bind(organisationId)
      .all()
  ).results;
  return snapshot;
}
