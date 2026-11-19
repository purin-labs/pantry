import type { SingleDatabase } from "../../src/database-handles";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "../fixtures/organisation-placement";
import { requireOrganisationBootstrap } from "../organisation-execution-fixture";
import { DatabaseSync } from "node:sqlite";

import { upsertUser } from "../../src/data/control-plane";
import type { User } from "../../src/data/control-plane";
import { organisationBootstrapMutation } from "../control-mutation-fixture";
import { TEST_INITIAL_ORGANISATION_PLACEMENT } from "../fixtures/organisation-placement";
import { d1Database } from "../sqlite-d1";
import { singleDatabaseSchema } from "../../scripts/single-database-schema.mjs";
export const ONBOARDING_FIXTURE_NOW = 1_784_093_296_426;

export type OnboardingOrganisationFixture = {
  readonly owner: User;
  readonly organisation: Awaited<
    ReturnType<typeof requireOrganisationBootstrap>
  >;
};

export function createOnboardingDatabase(): SingleDatabase {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(singleDatabaseSchema());
  return d1Database(sqlite);
}

export async function createOnboardingOrganisation(
  db: SingleDatabase,
  subject: string,
  now: number = ONBOARDING_FIXTURE_NOW,
): Promise<OnboardingOrganisationFixture> {
  const owner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject,
      email: `${subject}@example.com`,
      displayName: "Onboarding Fixture Owner",
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
    organisationName: "Onboarding Fixture Organisation",
    environment: "development",
    mutation: organisationBootstrapMutation(owner, now),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now,
  });
  return { owner, organisation };
}
