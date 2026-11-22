import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
import { requireOrganisationBootstrap } from "./organisation-execution-fixture";
import { describe, expect, it } from "vitest";

import { tearDownAgentMailboxForRemoval } from "../src/mail-inbox/agent-mailbox-teardown";
import { upsertUser } from "@purin-labs/tenancy/data/control-plane";
import { registerEmailMailboxAccount } from "../src/data/email-mailbox";
import {
  createConnectedIntegration,
  setIntegrationAccountLifecycle,
  type ConnectedIntegrationSeed,
} from "@purin-labs/connections/data/integration-account";
import {
  parseIntegrationAccountId,
  type IntegrationAccountId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { type UserId } from "@purin-labs/control-api/ids";
import { organisationBootstrapMutation } from "./control-mutation-fixture";
import { TEST_INITIAL_ORGANISATION_PLACEMENT } from "./fixtures/organisation-placement";
import { requireVaultHandle } from "./test-ids";
import { createMigratedDatabase } from "./sqlite-d1";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";

const NOW = 1_784_016_325_277;

describe("agent mailbox teardown before removal", teardownSuite);

function teardownSuite(): void {
  it("stops the watch and reports drafts it could not delete", teardownTest);
  it("leaves non-mailbox accounts alone", nonMailboxTest);
}

/**
 * Removal revokes the organisation's Google grant, and a revoked grant cannot delete
 * anything. The teardown therefore runs first, and a draft it could not remove
 * is reported rather than stranded silently in the organisation's mailbox.
 */
async function teardownTest(): Promise<void> {
  const fixture = await createFixture("teardown");
  const outcome = await tearDownAgentMailboxForRemoval(
    fixture.env,
    await requireOrganisationExecutionScope(
      fixture.env,
      fixture.organisationId,
    ),
    fixture.integrationAccountId,
    "erase",
  );
  expect(outcome).toEqual({
    kind: "torn_down",
    watchStopped: true,
    cleanupNeeded: [
      {
        proposalId: "proposal_stuck",
        version: 2,
        state: "cleanup_unreachable",
      },
    ],
  });
  expect(fixture.calls).toContain("revokeEmailMailbox");
  expect(fixture.calls).toContain("revokeEmailOperationalProposals");
}

async function nonMailboxTest(): Promise<void> {
  const fixture = await createFixture("plain");
  const otherAccount = parseIntegrationAccountId(
    "integration_account_not_a_mailbox",
  );
  if (!otherAccount.ok) throw new Error("bad fixture id");
  const outcome = await tearDownAgentMailboxForRemoval(
    fixture.env,
    await requireOrganisationExecutionScope(
      fixture.env,
      fixture.organisationId,
    ),
    otherAccount.value,
    "erase",
  );
  expect(outcome).toEqual({ kind: "not_a_mailbox" });
  expect(fixture.calls).not.toContain("revokeEmailMailbox");
}

type Fixture = {
  readonly env: UnitTestEnv;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly calls: string[];
};

async function createFixture(slug: string): Promise<Fixture> {
  const db = createMigratedDatabase();
  const owner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: `${slug}-owner`,
      email: `${slug}@example.com`,
      displayName: `${slug} owner`,
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
    organisationName: `Teardown ${slug}`,
    environment: "development",
    mutation: organisationBootstrapMutation(owner, NOW),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: NOW,
  });
  const connected = await createConnectedIntegration(
    db,
    gmailSeed(
      organisation.organisationId,
      owner.userId,
      `T-${slug.toUpperCase()}`,
      NOW + 1,
    ),
  );
  await setIntegrationAccountLifecycle({
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    lifecycle: { kind: "active" },
    now: NOW + 2,
  });
  const registered = await registerEmailMailboxAccount({
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    environment: "development",
    googleSubject: `google-sub-${slug}`,
    observedAddress: `${slug}@example.com`,
    now: NOW + 3,
  });
  if (!registered.ok) throw new Error(registered.error.code);

  const calls: string[] = [];
  const stub = {
    async activate() {
      return { ok: true, value: { stateVersion: 1 } };
    },
    async revokeEmailOperationalProposals() {
      calls.push("revokeEmailOperationalProposals");
      return { ok: true, value: { revoked: [] } };
    },
    async revokeEmailMailbox() {
      calls.push("revokeEmailMailbox");
      return {
        ok: true,
        value: {
          watchStopped: true,
          disposals: [
            { proposalId: "proposal_clean", version: 1, kind: "deleted" },
            {
              proposalId: "proposal_stuck",
              version: 2,
              kind: "cleanup_unreachable",
            },
          ],
        },
      };
    },
  };
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: () => stub,
    jurisdiction: () => namespace,
  };
  return {
    env: platformEnv({
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
      CONNECTOR: namespace,
    }),
    organisationId: organisation.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    calls,
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
