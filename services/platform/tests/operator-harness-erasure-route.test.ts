import { requireOrganisationBootstrap } from "./organisation-execution-fixture";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";

import { handleControlRequest } from "../src/control-router";
import { issueControlSession, upsertUser } from "@purin-labs/tenancy/data/control-plane";
import { newControlMutationIdentity } from "@purin-labs/tenancy/data/control-mutation";
import { archiveOrganisation } from "@purin-labs/tenancy/data/organisation-lifecycle";
import type { SessionDO } from "../src/actors/agent-session";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { organisationBootstrapMutation } from "./control-mutation-fixture";
import {
  TEST_INITIAL_ORGANISATION_PLACEMENT,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
import { createMigratedDatabase } from "./sqlite-d1";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";
import "./provide-organisation-lifecycle-parts";

const ORIGIN = "https://pantry.example";

describe("operator harness erasure routes", () => {
  it("requires the support administrator role", async () => {
    const fixture = await createFixture();
    const denied = await handleControlRequest(
      readRequest(
        `/v1/control/operator/organisations/${fixture.organisationId}/harness-erasure`,
        fixture.ownerSessionToken,
      ),
      fixture.env,
    );
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({
      error: "support_admin_role_required",
    });
  });

  it("reports the retention fence and receipts to a support administrator", async () => {
    const fixture = await createFixture();
    const response = await handleControlRequest(
      readRequest(
        `/v1/control/operator/organisations/${fixture.organisationId}/harness-erasure`,
        fixture.supportSessionToken,
      ),
      fixture.env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      kind: "success",
      receipts: {
        schemaVersion: "organisation_harness_erasure_receipts.v1",
        organisationId: fixture.organisationId,
        status: "retention_window_open",
        purgeAfter: fixture.purgeAfter,
        sessionReceipts: [],
      },
    });
  });

  it("returns the read-only harness history inventory to a support administrator", async () => {
    const fixture = await createFixture();
    const response = await handleControlRequest(
      readRequest(
        `/v1/control/operator/organisations/${fixture.organisationId}/harness-history`,
        fixture.supportSessionToken,
      ),
      fixture.env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      kind: "success",
      inventory: {
        schemaVersion: "organisation_harness_history_inventory.v1",
        organisationId: fixture.organisationId,
        sessions: [],
        candidateObjectKeys: [],
        retainedObjectKeys: [],
      },
    });
  });
});

type RouteFixture = {
  readonly env: UnitTestEnv;
  readonly organisationId: OrganisationId;
  readonly purgeAfter: number;
  readonly ownerSessionToken: string;
  readonly supportSessionToken: string;
};

async function createFixture(): Promise<RouteFixture> {
  const db = createMigratedDatabase();
  const now = Date.now();
  const owner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "harness-erasure-owner",
      email: "harness-erasure-owner@example.com",
      displayName: "Harness Erasure Owner",
      emailVerified: true,
    },
    now,
  });
  const organisation = await requireOrganisationBootstrap({
    env: {
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    owner,
    organisationName: "Harness Erasure Route Organisation",
    environment: "development",
    mutation: organisationBootstrapMutation(owner, now),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now,
  });
  const archived = await archiveOrganisation({
    identityDatabase: db,
    execution: await requireOrganisationExecutionScope(
      {
        DB: db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      organisation.organisationId,
    ),
    actorUserId: owner.userId,
    mutation: {
      boundary: {
        kind: "configuration_versioned",
        idempotencyKey: "harness-erasure-route-archive-0001",
        requestHash: "harness-erasure-route-archive-request",
        expectedConfigurationVersion: 1,
      },
      scope: {
        userId: owner.userId,
        organisationScope: organisation.organisationId,
        route: `/v1/control/organisations/${organisation.organisationId}/archive`,
        operation: "organisation.archive",
      },
      identity: newControlMutationIdentity({
        portalSubjectHash: "harness-erasure-route-subject",
        causationId: "harness-erasure-route-archive",
        now: now + 1,
      }),
    },
    authority: { kind: "organisation_owner" },
    reasonCode: "merchant_archived",
    now: now + 1,
  });
  if (!archived.ok) {
    throw new Error(archived.error.code);
  }
  const support = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "harness-erasure-support",
      email: "harness-erasure-support@example.com",
      displayName: "Harness Erasure Support",
      emailVerified: true,
    },
    now,
  });
  await db
    .prepare(
      `INSERT INTO control_support_role (
       user_id, role, granted_by_user_id, granted_at, revoked_at
     ) VALUES (?, 'support_admin', NULL, ?, NULL)`,
    )
    .bind(support.userId, now)
    .run();
  const ownerSession = await issueControlSession({
    db,
    userId: owner.userId,
    now,
    ttlMs: 60 * 60 * 1000,
  });
  const supportSession = await issueControlSession({
    db,
    userId: support.userId,
    now,
    ttlMs: 60 * 60 * 1000,
  });
  return {
    env: platformEnv({
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
      PANTRY_PUBLIC_ORIGIN: ORIGIN,
      SESSION: emptySessionNamespace(),
    }),
    organisationId: organisation.organisationId,
    purgeAfter: archived.value.purgeAfter,
    ownerSessionToken: ownerSession.token,
    supportSessionToken: supportSession.token,
  };
}

function readRequest(path: string, sessionToken: string): Request {
  return new Request(`${ORIGIN}${path}`, {
    headers: { cookie: `pantry_session=${sessionToken}` },
  });
}

function emptySessionNamespace(): DurableObjectNamespace<SessionDO> {
  return {
    idFromName(name: string): string {
      return name;
    },
    get(): never {
      throw new Error("no session actors are registered in this fixture");
    },
  } as unknown as DurableObjectNamespace<SessionDO>;
}
