import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
import { requireOrganisationBootstrap } from "./organisation-execution-fixture";
import { describe, expect, it } from "vitest";

import {
  changeOrganisationServiceRole,
  issueControlSession,
  resolveControlSession,
  revokeControlSession,
  rotateControlSession,
  upsertUser,
  validateControlCsrf,
} from "../src/data/control-plane";
import { newControlMutationIdentity } from "../src/data/control-mutation";
import { type OrganisationId } from "@purin-labs/kernel/ids";
import { type UserId } from "@purin-labs/control-api/ids";
import { organisationBootstrapMutation } from "./control-mutation-fixture";
import { TEST_INITIAL_ORGANISATION_PLACEMENT } from "./fixtures/organisation-placement";
import { createMigratedDatabase } from "./sqlite-d1";
import "./provide-organisation-lifecycle-parts";

const NOW = 1_783_987_896_426;
const SESSION_TTL_MS = 30 * 60 * 1000;

describe("control plane", () => {
  it("rotates opaque credentials and rejects stale, expired, revoked, and invalid-CSRF sessions", async () => {
    const db = createMigratedDatabase();
    const owner = await upsertUser({
      db,
      identity: {
        issuer: "https://accounts.google.com",
        subject: "session-owner",
        email: "session@example.com",
        displayName: "Session Owner",
        emailVerified: true,
      },
      now: NOW,
    });
    const issued = await issueControlSession({
      db,
      userId: owner.userId,
      now: NOW,
      ttlMs: SESSION_TTL_MS,
    });

    await expect(
      validateControlCsrf({
        db,
        session: issued.session,
        csrfToken: issued.csrfToken,
      }),
    ).resolves.toEqual({ ok: true, value: true });
    await expect(
      validateControlCsrf({
        db,
        session: issued.session,
        csrfToken: "invalid",
      }),
    ).resolves.toEqual({ ok: false, error: { code: "csrf_invalid" } });

    const rotated = await rotateControlSession({
      db,
      session: issued.session,
      now: NOW + 1_000,
      expiresAt: NOW + 1_000 + SESSION_TTL_MS,
    });
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) {
      throw new Error(rotated.error.code);
    }

    await expect(
      resolveControlSession({ db, token: issued.token, now: NOW + 1_001 }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "control_session_missing" },
    });
    await expect(
      resolveControlSession({
        db,
        token: rotated.value.token,
        now: rotated.value.session.expiresAt,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "control_session_expired" },
    });

    await revokeControlSession({
      db,
      session: rotated.value.session,
      now: NOW + 2_000,
    });
    await expect(
      resolveControlSession({
        db,
        token: rotated.value.token,
        now: NOW + 2_001,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "control_session_revoked" },
    });
  });

  it("rejects final-owner demotion and removal under the persistence invariant", async () => {
    const db = createMigratedDatabase();
    const owner = await upsertTestIdentity(
      db,
      "final-owner",
      "final-owner@team.test",
      "Final Owner",
    );
    const organisation = await requireOrganisationBootstrap({
      env: {
        DB: db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      owner,
      organisationName: "Owner Guard Commerce",
      environment: "development",
      mutation: organisationBootstrapMutation(owner, NOW),
      placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
      now: NOW,
    });
    await expect(
      db
        .prepare(
          "UPDATE service_role_grant SET status = 'revoked', revoked_at = ? WHERE organisation_id = ? AND user_id = ?",
        )
        .bind(NOW + 1, organisation.organisationId, owner.userId)
        .run(),
    ).rejects.toThrow("organisation_final_owner_required");
    await expect(
      changeOrganisationServiceRole({
        db,
        organisationId: organisation.organisationId,
        targetUserId: owner.userId,
        nextRole: "admin",
        changedByUserId: owner.userId,
        mutation: membershipMutation(
          owner.userId,
          organisation.organisationId,
          "demote-final-owner",
          1,
          NOW + 2,
        ),
        now: NOW + 2,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "organisation_final_owner_required" },
    });
    await expect(
      db
        .prepare(
          `UPDATE service_role_grant SET role = 'admin'
       WHERE organisation_id = ? AND user_id = ?`,
        )
        .bind(organisation.organisationId, owner.userId)
        .run(),
    ).rejects.toThrow("organisation_final_owner_required");
    const secondOwner = await upsertTestIdentity(
      db,
      "second-owner",
      "second-owner@team.test",
      "Second Owner",
    );
    await db.batch([
      db
        .prepare(
          `INSERT INTO person (organisation_id, person_id, display_name)
         VALUES (?, 'person_second_owner', 'Second Owner')`,
        )
        .bind(organisation.organisationId),
      db
        .prepare(
          `INSERT INTO service_role_grant (
           organisation_id, user_id, person_id, role, status, created_at, revoked_at
         ) VALUES (?, ?, 'person_second_owner', 'owner', 'active', ?, NULL)`,
        )
        .bind(organisation.organisationId, secondOwner.userId, NOW + 3),
    ]);
    await expect(
      changeOrganisationServiceRole({
        db,
        organisationId: organisation.organisationId,
        targetUserId: owner.userId,
        nextRole: "admin",
        changedByUserId: secondOwner.userId,
        mutation: membershipMutation(
          secondOwner.userId,
          organisation.organisationId,
          "demote-with-replacement",
          1,
          NOW + 4,
        ),
        now: NOW + 4,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        member: { role: "admin" },
      },
    });
  });
});

function membershipMutation(
  userId: UserId,
  organisationId: OrganisationId,
  key: string,
  expectedConfigurationVersion: number,
  now: number,
) {
  return {
    boundary: {
      kind: "configuration_versioned" as const,
      idempotencyKey: `${key}-idempotency`,
      requestHash: `${key}-request`,
      expectedConfigurationVersion,
    },
    scope: {
      userId,
      organisationScope: organisationId,
      route: `/v1/control/organisations/${organisationId}/members/${userId}`,
      operation: key.startsWith("remove")
        ? "organisation.membership.revoke"
        : "organisation.service-role.change",
    },
    identity: newControlMutationIdentity({
      portalSubjectHash: "membership-test-subject",
      causationId: `${key}-causation`,
      now,
    }),
  };
}

function upsertTestIdentity(
  db: SingleDatabase,
  subject: string,
  email: string,
  displayName: string,
) {
  return upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject,
      email,
      displayName,
      emailVerified: true,
    },
    now: NOW,
  });
}
