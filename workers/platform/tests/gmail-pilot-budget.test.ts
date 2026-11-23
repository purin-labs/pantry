import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
import { requireOrganisationBootstrap } from "./organisation-execution-fixture";
import { describe, expect, it } from "vitest";

import {
  readGmailPilotBudget,
  registerEmailMailboxAccount,
} from "@purin-labs/area-inbox/server/data/email-mailbox";
import { upsertUser } from "@purin-labs/tenancy/data/control-plane";
import {
  createConnectedIntegration,
  setIntegrationAccountLifecycle,
  type ConnectedIntegrationSeed,
} from "@purin-labs/connections/data/integration-account";
import { type IntegrationAccountId, type OrganisationId } from "@purin-labs/kernel/ids";
import { type UserId } from "@purin-labs/control-api/ids";
import { organisationBootstrapMutation } from "./control-mutation-fixture";
import { TEST_INITIAL_ORGANISATION_PLACEMENT } from "./fixtures/organisation-placement";
import { requireVaultHandle } from "./test-ids";
import { createMigratedDatabase } from "./sqlite-d1";

const NOW = 1_784_016_325_277;

describe("gmail pilot account budget", pilotBudgetSuite);

function pilotBudgetSuite(): void {
  it("keeps the slot of a revoked mailbox spent", revocationTest);
}

/**
 * Google's allowance counts Google accounts that have ever consented, and does
 * not give a slot back when one is removed. Counting live mailboxes instead
 * would quietly overstate remaining capacity and let the project run out mid
 * pilot, so the count has to survive revocation.
 */
async function revocationTest(): Promise<void> {
  const fixture = await createFixture();
  const integrationAccountId = await connect(fixture, "google-sub-alpha");
  expect(await budget(fixture)).toMatchObject({ consumed: 1, remaining: 79 });

  await setIntegrationAccountLifecycle({
    db: fixture.db,
    organisationId: fixture.organisationId,
    integrationAccountId,
    lifecycle: { kind: "revoked", revokedAt: NOW + 100 },
    now: NOW + 100,
  });
  expect(await budget(fixture)).toMatchObject({ consumed: 1, remaining: 79 });
}

type Fixture = {
  readonly db: SingleDatabase;
  readonly organisationId: OrganisationId;
  readonly userId: UserId;
};

async function budget(
  fixture: Fixture,
): Promise<Awaited<ReturnType<typeof readGmailPilotBudget>>> {
  return readGmailPilotBudget({
    databases: [fixture.db],
    environment: "development",
    operatingCap: 80,
    submissionTrigger: 50,
  });
}

async function connect(
  fixture: Fixture,
  googleSubject: string,
): Promise<IntegrationAccountId> {
  const connected = await createConnectedIntegration(
    fixture.db,
    gmailSeed(fixture.organisationId, fixture.userId, "G-ALPHA", NOW),
  );
  const integrationAccountId = connected.account.integrationAccountId;
  await setIntegrationAccountLifecycle({
    db: fixture.db,
    organisationId: fixture.organisationId,
    integrationAccountId,
    lifecycle: { kind: "active" },
    now: NOW + 1,
  });
  const registered = await registerEmailMailboxAccount({
    db: fixture.db,
    organisationId: fixture.organisationId,
    integrationAccountId,
    environment: "development",
    googleSubject,
    observedAddress: "alpha@example.com",
    now: NOW + 2,
  });
  if (!registered.ok) throw new Error(registered.error.code);
  return integrationAccountId;
}

async function createFixture(): Promise<Fixture> {
  const db = createMigratedDatabase();
  const owner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "budget-owner",
      email: "budget@example.com",
      displayName: "Budget owner",
      emailVerified: true,
    },
    now: NOW,
  });
  const organisation = await requireOrganisationBootstrap({
    env: {
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    owner,
    organisationName: "Budget organisation",
    environment: "development",
    mutation: organisationBootstrapMutation(owner, NOW),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: NOW,
  });
  return {
    db,
    organisationId: organisation.organisationId,
    userId: owner.userId,
  };
}

function gmailSeed(
  organisationId: OrganisationId,
  userId: UserId,
  providerAccountId: string,
  now: number,
): ConnectedIntegrationSeed {
  return {
    organisationId,
    provider: "gmail",
    providerSubjectId: providerAccountId,
    environment: "development",
    authMode: "shared_pantry_app",
    authority: {
      kind: "connection_credential",
      credentialRef: requireVaultHandle(
        `vault:organisation:gmail:${providerAccountId.toLowerCase()}:oauth:g1`,
      ),
    },
    grantedScopes: ["openid", "email"],
    createdByUserId: userId,
    providerAccountId,
    accountKind: "mailbox",
    displayName: providerAccountId,
    capabilities: ["mailbox.ingress"],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now,
  };
}
