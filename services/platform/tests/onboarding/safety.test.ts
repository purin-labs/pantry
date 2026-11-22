import { describe, expect, it } from "vitest";

import { buildOnboardingProjection } from "@purin-labs/area-organisation/server/data/onboarding-projection";
import {
  prepareFirstOperationalTask,
  readFirstOperationalTask,
} from "@purin-labs/area-organisation/server/data/first-operational-task";
import {
  newActivationAttemptId,
  newActivationReceiptId,
} from "@purin-labs/kernel/ids";
import {
  createOnboardingDatabase,
  createOnboardingOrganisation,
  ONBOARDING_FIXTURE_NOW,
} from "./fixtures";

describe("onboarding safety boundaries", () => {
  it("keeps a fresh projection explicit about the missing first task", async () => {
    const db = createOnboardingDatabase();
    const { owner, organisation } = await createOnboardingOrganisation(
      db,
      "projection-safety",
    );

    const projection = await buildOnboardingProjection({
      db,
      organisationId: organisation.organisationId,
      membership: organisation.membership,
      now: ONBOARDING_FIXTURE_NOW,
    });

    expect(projection?.first_task).toBeNull();
    expect(projection?.steps.map((step) => step.step)).toEqual([
      "workspace",
      "inference",
      "commerce",
      "conversations",
      "operating_profile",
      "review_activation",
    ]);
    expect(projection?.next_action.kind).toBe("perform");
    expect(owner.userId).toBe(organisation.membership.userId);
  });

  it("does not invent a first task before activation persists one", async () => {
    const db = createOnboardingDatabase();
    const { organisation } = await createOnboardingOrganisation(
      db,
      "first-task-safety",
    );

    await expect(
      readFirstOperationalTask(db, organisation.organisationId),
    ).resolves.toBeNull();
  });

  it("projects the persisted first task after activation", async () => {
    const db = createOnboardingDatabase();
    const { organisation } = await createOnboardingOrganisation(
      db,
      "first-task-projection",
    );
    const task = {
      kind: "observe_recent_commerce" as const,
      organisation_id: organisation.organisationId,
      commerce_system_revision: 1,
      destination_id: "channel_fixture",
    };
    const activationAttemptId = newActivationAttemptId();
    const activationReceiptId = newActivationReceiptId();

    await db.batch([
      db
        .prepare(
          `INSERT INTO organisation_activation_attempt (
           activation_attempt_id, organisation_id, readiness_version, readiness_hash,
           status, started_at, updated_at, completed_at
         ) VALUES (?, ?, 1, 'fixture-readiness', 'completed', ?, ?, ?)`,
        )
        .bind(
          activationAttemptId,
          organisation.organisationId,
          ONBOARDING_FIXTURE_NOW,
          ONBOARDING_FIXTURE_NOW,
          ONBOARDING_FIXTURE_NOW + 1,
        ),
      db
        .prepare(
          `INSERT INTO organisation_activation_receipt (
           activation_receipt_id, activation_attempt_id, organisation_id, readiness_hash,
           policy_snapshot_id, cue_snapshot_id, capability_profile, activated_at
         ) VALUES (?, ?, ?, 'fixture-readiness', 'fixture-policy', 'fixture-cues', 'read_and_propose', ?)`,
        )
        .bind(
          activationReceiptId,
          activationAttemptId,
          organisation.organisationId,
          ONBOARDING_FIXTURE_NOW + 1,
        ),
    ]);

    await db.batch([
      prepareFirstOperationalTask(
        db,
        activationReceiptId,
        task,
        ONBOARDING_FIXTURE_NOW + 1,
      ),
    ]);

    const projection = await buildOnboardingProjection({
      db,
      organisationId: organisation.organisationId,
      membership: organisation.membership,
      now: ONBOARDING_FIXTURE_NOW,
    });
    expect(projection?.first_task).toEqual(task);
    const reactivatedTask = {
      kind: "observe_recent_commerce" as const,
      organisation_id: organisation.organisationId,
      commerce_system_revision: 2,
      destination_id: "channel_reconnected",
    };
    await prepareFirstOperationalTask(
      db,
      activationReceiptId,
      reactivatedTask,
      ONBOARDING_FIXTURE_NOW + 2,
    ).run();
    await expect(
      readFirstOperationalTask(db, organisation.organisationId),
    ).resolves.toEqual(reactivatedTask);
  });

  it("fails closed when a membership is paired with another organisation", async () => {
    const db = createOnboardingDatabase();
    const first = await createOnboardingOrganisation(
      db,
      "organisation-boundary-one",
    );
    const second = await createOnboardingOrganisation(
      db,
      "organisation-boundary-two",
    );

    await expect(
      buildOnboardingProjection({
        db,
        organisationId: first.organisation.organisationId,
        membership: second.organisation.membership,
        now: ONBOARDING_FIXTURE_NOW,
      }),
    ).resolves.toBeNull();
  });
});
