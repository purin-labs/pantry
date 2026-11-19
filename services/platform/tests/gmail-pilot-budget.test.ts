import type { SingleDatabase } from "../src/database-handles";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
import { requireOrganisationBootstrap } from "./organisation-execution-fixture";
import { describe, expect, it } from "vitest";

import {
  readGmailPilotBudget,
  registerEmailMailboxAccount,
} from "../src/data/email-mailbox";
import { upsertUser } from "../src/data/control-plane";
import {
  createConnectedIntegration,
  setIntegrationAccountLifecycle,
  type ConnectedIntegrationSeed,
} from "../src/data/integration-account";
import { type UserId, type OrganisationId } from "../src/ids";
import { organisationBootstrapMutation } from "./control-mutation-fixture";
import { TEST_INITIAL_ORGANISATION_PLACEMENT } from "./fixtures/organisation-placement";
import { requireIntegrationAccountId, requireVaultHandle } from "./test-ids";
import { createMigratedDatabase } from "./sqlite-d1";

const NOW = 1_784_016_325_277;

describe("gmail pilot account budget", pilotBudgetSuite);

function pilotBudgetSuite(): void {
  it("counts unique Google accounts as a lifetime spend", lifetimeTest);
  it("escalates at the submission trigger and again at the cap", thresholdTest);
}

/**
 * Google's allowance counts Google accounts that have ever consented, and does
 * not give a slot back when one is removed. Counting live mailboxes instead
 * would quietly overstate remaining capacity and let the project run out mid
 * pilot, so the count has to survive revocation and ignore re-authorization.
 */
async function lifetimeTest(): Promise<void> {
  const fixture = await createFixture();
  await connect(fixture, "alpha", "google-sub-alpha");
  await connect(fixture, "beta", "google-sub-beta");
  expect((await budget(fixture)).consumed).toBe(2);

  // Re-authorizing reuses the same mailbox account, so it spends nothing.
  const reauthorized = await registerEmailMailboxAccount({
    db: fixture.db,
    organisationId: fixture.organisationId,
    integrationAccountId: requireIntegrationAccountId(
      fixture.accounts["alpha"] ?? "",
    ),
    environment: "development",
    googleSubject: "google-sub-alpha",
    observedAddress: "alpha@example.com",
    now: NOW + 50,
  });
  expect(reauthorized.ok).toBe(true);
  expect((await budget(fixture)).consumed).toBe(2);

  // And one Google account cannot be claimed by a second mailbox, so a slot
  // can never be double-spent.
  const second = await createConnectedIntegration(
    fixture.db,
    gmailSeed(fixture.organisationId, fixture.userId, "G-DUPLICATE", NOW),
  );
  const duplicate = await registerEmailMailboxAccount({
    db: fixture.db,
    organisationId: fixture.organisationId,
    integrationAccountId: second.account.integrationAccountId,
    environment: "development",
    googleSubject: "google-sub-alpha",
    observedAddress: "alpha-alias@example.com",
    now: NOW + 60,
  });
  expect(duplicate).toMatchObject({
    ok: false,
    error: { code: "email_mailbox_identity_claimed" },
  });
  expect((await budget(fixture)).consumed).toBe(2);

  // Revoking a mailbox does not refund its slot.
  await setIntegrationAccountLifecycle({
    db: fixture.db,
    organisationId: fixture.organisationId,
    integrationAccountId: requireIntegrationAccountId(
      fixture.accounts["beta"] ?? "",
    ),
    lifecycle: { kind: "revoked", revokedAt: NOW + 100 },
    now: NOW + 100,
  });
  const afterRevocation = await budget(fixture);
  expect(afterRevocation.consumed).toBe(2);
  expect(afterRevocation.remaining).toBe(78);

  // A different project's environment keeps its own budget.
  const production = await readGmailPilotBudget({
    databases: [fixture.db],
    environment: "production",
    operatingCap: 80,
    submissionTrigger: 50,
  });
  expect(production).toMatchObject({
    consumed: 0,
    remaining: 80,
    status: "healthy",
  });
}

async function thresholdTest(): Promise<void> {
  const fixture = await createFixture();
  await connect(fixture, "one", "google-sub-one");

  expect((await budget(fixture, { cap: 80, trigger: 50 })).status).toBe(
    "healthy",
  );
  // At the trigger, verification has to start while capacity still remains.
  expect((await budget(fixture, { cap: 80, trigger: 1 })).status).toBe(
    "submit_verification",
  );
  expect((await budget(fixture, { cap: 1, trigger: 1 })).status).toBe(
    "exhausted",
  );
  expect((await budget(fixture, { cap: 1, trigger: 1 })).remaining).toBe(0);
}

type Fixture = {
  readonly db: SingleDatabase;
  readonly organisationId: OrganisationId;
  readonly userId: UserId;
  readonly accounts: Record<string, string>;
};

async function budget(
  fixture: Fixture,
  limits: Readonly<{ cap: number; trigger: number }> = { cap: 80, trigger: 50 },
): Promise<Awaited<ReturnType<typeof readGmailPilotBudget>>> {
  return readGmailPilotBudget({
    databases: [fixture.db],
    environment: "development",
    operatingCap: limits.cap,
    submissionTrigger: limits.trigger,
  });
}

async function connect(
  fixture: Fixture,
  slug: string,
  googleSubject: string,
): Promise<void> {
  const connected = await createConnectedIntegration(
    fixture.db,
    gmailSeed(
      fixture.organisationId,
      fixture.userId,
      `G-${slug.toUpperCase()}`,
      NOW,
    ),
  );
  await setIntegrationAccountLifecycle({
    db: fixture.db,
    organisationId: fixture.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    lifecycle: { kind: "active" },
    now: NOW + 1,
  });
  const registered = await registerEmailMailboxAccount({
    db: fixture.db,
    organisationId: fixture.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    environment: "development",
    googleSubject,
    observedAddress: `${slug}@example.com`,
    now: NOW + 2,
  });
  if (!registered.ok) throw new Error(registered.error.code);
  fixture.accounts[slug] = connected.account.integrationAccountId;
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
    accounts: {},
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
    authMode: "shared_satyr_app",
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
