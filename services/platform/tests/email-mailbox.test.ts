import type { SingleDatabase } from "../src/database-handles";
import { requireOrganisationBootstrap } from "./organisation-execution-fixture";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
import { describe, expect, it } from "vitest";

import { upsertUser } from "../src/data/control-plane";
import {
  assignAgentMailbox,
  bindEmailMessageReceiptContact,
  emailMessageReceiptMatches,
  parseMailboxIngressPolicyPublishRequest,
  publishMailboxIngressPolicy,
  readAgentMailboxBinding,
  readEmailMailboxAccount,
  readEmailThreadCase,
  readMailboxIngressPolicy,
  recordEmailMessageReceipt,
  recordEmailThreadCase,
  registerEmailMailboxAccount,
} from "../src/data/email-mailbox";
import {
  gmailConnectorIdValue,
} from "../src/mail-inbox/contract/connector-ids";
import {
  createConnectedIntegration,
  setIntegrationAccountLifecycle,
  type ConnectedIntegrationSeed,
} from "../src/data/integration-account";
import {
  buildAgentMailboxAuthority,
  validateNativeRequestAuthority,
} from "../src/request-authority";
import {
  type UserId,
  type IntegrationAccountId,
  type OrganisationId,
} from "../src/ids";
import { organisationBootstrapMutation } from "./control-mutation-fixture";
import { TEST_INITIAL_ORGANISATION_PLACEMENT } from "./fixtures/organisation-placement";
import {
  requireCaseId as requireCaseIdValue,
  requireIntegrationAccountId,
  requireVaultHandle,
} from "./test-ids";
import { createMigratedDatabase } from "./sqlite-d1";

const NOW = 1_784_016_325_277;

describe("email mailbox persistence", emailMailboxSuite);

function emailMailboxSuite(): void {
  it("claims one immutable Google identity per environment", identityClaimTest);
  it(
    "resolves missing policy to disabled_by_default and appends published revisions",
    policyRevisionTest,
  );
  it(
    "rejects invalid mailbox policy publish requests at the boundary",
    policyBoundaryTest,
  );
  it(
    "appends immutable binding revisions with a current pointer",
    bindingRevisionTest,
  );
  it("rejects cross-organisation mailbox rows in D1", crossOrganisationTest);
  it(
    "validates live agent_mailbox authority against current revisions",
    liveAuthorityTest,
  );
  it(
    "keeps one stable Case per Gmail thread and deduplicates message receipts",
    threadCaseTest,
  );
}

async function identityClaimTest(): Promise<void> {
  const fixture = await createFixture("identity");
  const registered = await registerEmailMailboxAccount({
    db: fixture.db,
    organisationId: fixture.organisationId,
    integrationAccountId: fixture.integrationAccountId,
    environment: "development",
    googleSubject: "google-sub-1",
    observedAddress: "owner@example.com",
    now: NOW + 10,
  });
  expect(registered.ok).toBe(true);

  const otherOrganisation = await createOrganisationWithGmailAccount(
    fixture.db,
    "identity-second",
    "G-SECOND",
  );
  const stolen = await registerEmailMailboxAccount({
    db: fixture.db,
    organisationId: otherOrganisation.organisationId,
    integrationAccountId: otherOrganisation.integrationAccountId,
    environment: "development",
    googleSubject: "google-sub-1",
    observedAddress: "attacker@example.com",
    now: NOW + 20,
  });
  expect(stolen.ok).toBe(false);
  if (!stolen.ok)
    expect(stolen.error.code).toBe("email_mailbox_identity_claimed");

  const reconnected = await registerEmailMailboxAccount({
    db: fixture.db,
    organisationId: fixture.organisationId,
    integrationAccountId: fixture.integrationAccountId,
    environment: "development",
    googleSubject: "google-sub-1",
    observedAddress: "renamed@example.com",
    now: NOW + 30,
  });
  expect(reconnected.ok).toBe(true);
  if (reconnected.ok) {
    expect(reconnected.value.observedAddress).toBe("renamed@example.com");
    expect(reconnected.value.addressObservedAt).toBe(NOW + 30);
  }
  const read = await readEmailMailboxAccount(fixture);
  expect(read.ok && read.value.googleSubject === "google-sub-1").toBe(true);
}

async function policyRevisionTest(): Promise<void> {
  const fixture = await createFixture("policy");
  await register(fixture, "google-sub-policy");

  const missing = await readMailboxIngressPolicy({
    ...fixture,
    connectedAt: NOW + 1,
  });
  expect(missing).toEqual({
    kind: "disabled_by_default",
    connectedAt: NOW + 1,
  });

  const enabled = await publishMailboxIngressPolicy({
    ...fixture,
    environment: "development",
    request: enabledPublishRequest(),
    publishedBy: fixture.userId,
    now: NOW + 40,
  });
  expect(enabled.ok).toBe(true);
  if (enabled.ok) {
    expect(enabled.value.kind).toBe("enabled");
    if (enabled.value.kind === "enabled") {
      expect(enabled.value.policyVersion).toBe(1);
      expect(enabled.value.debounce.coalesceSeconds).toBe(30);
    }
  }

  const disabled = await publishMailboxIngressPolicy({
    ...fixture,
    environment: "development",
    request: { kind: "disabled_by_operator" },
    publishedBy: fixture.userId,
    now: NOW + 50,
  });
  expect(disabled.ok).toBe(true);
  if (disabled.ok) {
    expect(disabled.value.kind).toBe("disabled_by_operator");
    if (disabled.value.kind === "disabled_by_operator") {
      expect(disabled.value.policyVersion).toBe(2);
    }
  }

  const current = await readMailboxIngressPolicy({
    ...fixture,
    connectedAt: NOW + 1,
  });
  expect(current.kind).toBe("disabled_by_operator");

  const revisions = await fixture.db
    .prepare(
      "SELECT COUNT(*) AS total FROM mailbox_ingress_policy_revision WHERE integration_account_id = ?",
    )
    .bind(fixture.integrationAccountId)
    .first<{ readonly total: number }>();
  expect(revisions?.total).toBe(2);
}

function policyBoundaryTest(): void {
  expect(
    parseMailboxIngressPolicyPublishRequest({ kind: "disabled_by_operator" })
      .ok,
  ).toBe(true);
  expect(
    parseMailboxIngressPolicyPublishRequest(enabledPublishRequest()).ok,
  ).toBe(true);

  const invalidCases: readonly unknown[] = [
    null,
    { kind: "enabled" },
    { kind: "enabled_by_default" },
    { kind: "disabled_by_operator", maxActiveCases: 1 },
    { ...enabledPublishRequest(), maxActiveCases: 0 },
    { ...enabledPublishRequest(), maxMessagesPerHour: -5 },
    { ...enabledPublishRequest(), dailyTokenBudget: 1.5 },
    { ...enabledPublishRequest(), maxMessageBytes: "1024" },
    { ...enabledPublishRequest(), maxAttachmentBytes: undefined },
    { ...enabledPublishRequest(), unexpected: true },
    {
      ...enabledPublishRequest(),
      debounce: { kind: "push_triggered", coalesceSeconds: 60 },
    },
    {
      ...enabledPublishRequest(),
      debounce: { kind: "fixed_five_minutes", coalesceSeconds: 30 },
    },
    { ...enabledPublishRequest(), overflow: "drop_oldest" },
  ];
  for (const raw of invalidCases) {
    expect(parseMailboxIngressPolicyPublishRequest(raw).ok).toBe(false);
  }
}

async function bindingRevisionTest(): Promise<void> {
  const fixture = await createFixture("binding");
  await register(fixture, "google-sub-binding");
  const firstInstallation = await seedInstallation(
    fixture,
    "install_first",
    "active",
  );
  const secondInstallation = await seedInstallation(
    fixture,
    "install_second",
    "active",
  );
  const suspended = await seedInstallation(
    fixture,
    "install_suspended",
    "suspended",
  );

  const first = await assignAgentMailbox({
    ...fixture,
    mailboxBindingId: "mailbox_binding_test",
    installationId: firstInstallation,
    grantsDigest: "a".repeat(64),
    policyDigest: "b".repeat(64),
    createdBy: fixture.userId,
    now: NOW + 60,
  });
  expect(first.ok && first.value.revision === 1).toBe(true);

  const second = await assignAgentMailbox({
    ...fixture,
    mailboxBindingId: "mailbox_binding_ignored",
    installationId: secondInstallation,
    grantsDigest: "c".repeat(64),
    policyDigest: "d".repeat(64),
    createdBy: fixture.userId,
    now: NOW + 70,
  });
  expect(second.ok && second.value.revision === 2).toBe(true);
  expect(
    second.ok && second.value.mailboxBindingId === "mailbox_binding_test",
  ).toBe(true);

  const current = await readAgentMailboxBinding(fixture);
  expect(current.ok).toBe(true);
  if (current.ok) {
    expect(current.value.binding.currentRevision).toBe(2);
    expect(current.value.currentRevision.installationId).toBe(
      secondInstallation,
    );
  }
  const firstRevision = await fixture.db
    .prepare(
      `SELECT installation_id AS installationId FROM agent_mailbox_binding_revision
       WHERE mailbox_binding_id = 'mailbox_binding_test' AND revision = 1`,
    )
    .first<{ readonly installationId: string }>();
  expect(firstRevision?.installationId).toBe(firstInstallation);

  const inactive = await assignAgentMailbox({
    ...fixture,
    mailboxBindingId: "mailbox_binding_other",
    installationId: suspended,
    grantsDigest: "e".repeat(64),
    policyDigest: "f".repeat(64),
    createdBy: fixture.userId,
    now: NOW + 80,
  });
  expect(inactive.ok).toBe(false);
  if (!inactive.ok)
    expect(inactive.error.code).toBe("mailbox_installation_inactive");
}

async function crossOrganisationTest(): Promise<void> {
  const fixture = await createFixture("cross-organisation");
  const other = await createOrganisationWithGmailAccount(
    fixture.db,
    "cross-other",
    "G-CROSS",
  );
  await expect(
    fixture.db
      .prepare(
        `INSERT INTO email_mailbox_account (
       integration_account_id, organisation_id, environment, google_subject,
       observed_address, address_observed_at
     ) VALUES (?, ?, 'development', 'stolen-subject', 'x@example.com', ?)`,
      )
      .bind(fixture.integrationAccountId, other.organisationId, NOW)
      .run(),
  ).rejects.toThrow();
}

async function liveAuthorityTest(): Promise<void> {
  const fixture = await createFixture("live-authority");
  await register(fixture, "google-sub-live");
  const installation = await seedInstallation(
    fixture,
    "install_live",
    "active",
  );
  const bound = await assignAgentMailbox({
    ...fixture,
    mailboxBindingId: "mailbox_binding_live",
    installationId: installation,
    grantsDigest: "1".repeat(64),
    policyDigest: "2".repeat(64),
    createdBy: fixture.userId,
    now: NOW + 90,
  });
  expect(bound.ok).toBe(true);
  const published = await publishMailboxIngressPolicy({
    ...fixture,
    environment: "development",
    request: enabledPublishRequest(),
    publishedBy: fixture.userId,
    now: NOW + 100,
  });
  expect(published.ok).toBe(true);

  const authority = buildAgentMailboxAuthority({
    organisationId: fixture.organisationId,
    integrationAccountId: fixture.integrationAccountId,
    mailboxBindingId: "mailbox_binding_live",
    bindingRevision: 1,
    mailboxPolicyVersion: 1,
  }).requestAuthority;
  if (authority.kind !== "agent_mailbox") {
    throw new Error(
      "agent mailbox authority builder returned the wrong branch",
    );
  }

  const active = await validateNativeRequestAuthority({
    db: fixture.db,
    authority,
  });
  expect(active.ok).toBe(true);

  const staleRevision = await validateNativeRequestAuthority({
    db: fixture.db,
    authority: { ...authority, bindingRevision: 9 },
  });
  expect(staleRevision.ok).toBe(false);

  const disabled = await publishMailboxIngressPolicy({
    ...fixture,
    environment: "development",
    request: { kind: "disabled_by_operator" },
    publishedBy: fixture.userId,
    now: NOW + 110,
  });
  expect(disabled.ok).toBe(true);
  const fenced = await validateNativeRequestAuthority({
    db: fixture.db,
    authority,
  });
  expect(fenced.ok).toBe(false);
}

async function threadCaseTest(): Promise<void> {
  const fixture = await createFixture("thread-case");
  await register(fixture, "google-sub-thread");
  const installation = await seedInstallation(
    fixture,
    "install_thread",
    "active",
  );
  const bound = await assignAgentMailbox({
    ...fixture,
    mailboxBindingId: "mailbox_binding_thread",
    installationId: installation,
    grantsDigest: "3".repeat(64),
    policyDigest: "4".repeat(64),
    createdBy: fixture.userId,
    now: NOW + 120,
  });
  expect(bound.ok).toBe(true);

  const caseId = requireCaseId("case_gmail_test_thread_1");
  const first = await recordEmailThreadCase({
    scope: await requireOrganisationExecutionScope(
      {
        DB: fixture.db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      fixture.organisationId,
    ),
    ...fixture,
    gmailThreadId: "thread-1",
    caseId,
    mailboxBindingId: "mailbox_binding_thread",
    bindingRevision: 1,
    now: NOW + 130,
  });
  expect(first.ok && first.value === caseId).toBe(true);

  const duplicate = await recordEmailThreadCase({
    scope: await requireOrganisationExecutionScope(
      {
        DB: fixture.db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      fixture.organisationId,
    ),
    ...fixture,
    gmailThreadId: "thread-1",
    caseId: requireCaseId("case_gmail_test_thread_other"),
    mailboxBindingId: "mailbox_binding_thread",
    bindingRevision: 1,
    now: NOW + 140,
  });
  expect(duplicate.ok && duplicate.value === caseId).toBe(true);
  expect(
    await readEmailThreadCase({ ...fixture, gmailThreadId: "thread-1" }),
  ).toBe(caseId);

  for (const attempt of [0, 1]) {
    const receipt = await recordEmailMessageReceipt({
      scope: await requireOrganisationExecutionScope(
        {
          DB: fixture.db,
          PANTRY_ORGANISATION_PLACEMENT_PROFILE:
            TEST_ORGANISATION_PLACEMENT_PROFILE,
        },
        fixture.organisationId,
      ),
      ...fixture,
      providerMessageId: "message-1",
      gmailThreadId: "thread-1",
      caseId,
      policyVersion: 1,
      now: NOW + 150 + attempt,
    });
    expect(receipt.ok).toBe(true);
  }
  const receipts = await fixture.db
    .prepare(
      "SELECT COUNT(*) AS total FROM email_message_receipt WHERE integration_account_id = ?",
    )
    .bind(fixture.integrationAccountId)
    .first<{ readonly total: number }>();
  expect(receipts?.total).toBe(1);
  const selectionReceipt = {
    ...fixture,
    providerMessageId: "message-1",
    caseId,
    admittedAt: NOW + 150,
    verificationId: "verification_supplier",
    verificationRevision: 3,
  };
  expect(await emailMessageReceiptMatches(selectionReceipt)).toBe(false);
  expect(
    await bindEmailMessageReceiptContact({
      scope: await requireOrganisationExecutionScope(
        {
          DB: fixture.db,
          PANTRY_ORGANISATION_PLACEMENT_PROFILE:
            TEST_ORGANISATION_PLACEMENT_PROFILE,
        },
        fixture.organisationId,
      ),
      integrationAccountId: selectionReceipt.integrationAccountId,
      providerMessageId: selectionReceipt.providerMessageId,
      caseId: selectionReceipt.caseId,
      admittedAt: selectionReceipt.admittedAt,
      verificationId: selectionReceipt.verificationId,
      verificationRevision: selectionReceipt.verificationRevision,
    }),
  ).toMatchObject({
    ok: true,
  });
  expect(await emailMessageReceiptMatches(selectionReceipt)).toBe(true);
  expect(
    await emailMessageReceiptMatches({
      ...selectionReceipt,
      admittedAt: NOW + 151,
    }),
  ).toBe(false);
  expect(
    await emailMessageReceiptMatches({
      ...selectionReceipt,
      caseId: requireCaseId("case_gmail_test_thread_other"),
    }),
  ).toBe(false);
  expect(
    await emailMessageReceiptMatches({
      ...selectionReceipt,
      verificationId: "verification_other",
    }),
  ).toBe(false);
  expect(gmailConnectorIdValue(fixture.integrationAccountId)).toBe(
    `connector_gmail_${fixture.integrationAccountId}`,
  );
}

type Fixture = {
  readonly db: SingleDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly userId: UserId;
};

async function createFixture(slug: string): Promise<Fixture> {
  const db = createMigratedDatabase();
  const seeded = await createOrganisationWithGmailAccount(
    db,
    slug,
    `G-${slug.toUpperCase()}`,
  );
  return { db, ...seeded };
}

async function createOrganisationWithGmailAccount(
  db: SingleDatabase,
  slug: string,
  providerAccountId: string,
): Promise<Omit<Fixture, "db">> {
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
    organisationName: `Mailbox ${slug}`,
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
      providerAccountId,
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
  return {
    organisationId: organisation.organisationId,
    integrationAccountId: requireIntegrationAccountId(
      connected.account.integrationAccountId,
    ),
    userId: owner.userId,
  };
}

async function register(
  fixture: Fixture,
  googleSubject: string,
): Promise<void> {
  const registered = await registerEmailMailboxAccount({
    ...fixture,
    environment: "development",
    googleSubject,
    observedAddress: `${googleSubject}@example.com`,
    now: NOW + 5,
  });
  if (!registered.ok) throw new Error(registered.error.code);
}

async function seedInstallation(
  fixture: Fixture,
  installationId: string,
  lifecycle: "active" | "suspended",
): Promise<string> {
  const definitionId = `${installationId}_definition`;
  await fixture.db
    .prepare(
      `INSERT INTO agent_definition (
       agent_definition_id, organisation_id, display_name, role, purpose, lifecycle,
       current_revision, created_by_user_id, created_at, updated_at
     ) VALUES (?, ?, 'Mailbox Agent', 'assistant', 'email replies', 'active', 1, ?, ?, ?)`,
    )
    .bind(definitionId, fixture.organisationId, fixture.userId, NOW, NOW)
    .run();
  await fixture.db
    .prepare(
      `INSERT INTO agent_definition_revision (
       agent_definition_id, organisation_id, revision, instructions,
       requested_capabilities_json, skill_refs_json, content_digest,
       authored_by_user_id, created_at
     ) VALUES (?, ?, 1, 'reply politely', '[]', '[]', ?, ?, ?)`,
    )
    .bind(
      definitionId,
      fixture.organisationId,
      "0".repeat(64),
      fixture.userId,
      NOW,
    )
    .run();
  await fixture.db
    .prepare(
      `INSERT INTO agent_installation (
       installation_id, organisation_id, agent_definition_id, definition_revision,
       policy_revision, granted_capabilities_json, lifecycle,
       created_by_user_id, created_at, updated_at
     ) VALUES (?, ?, ?, 1, 1, '[]', ?, ?, ?, ?)`,
    )
    .bind(
      installationId,
      fixture.organisationId,
      definitionId,
      lifecycle,
      fixture.userId,
      NOW,
      NOW,
    )
    .run();
  return installationId;
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
    grantedScopes: [
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
    ],
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

function enabledPublishRequest(): {
  readonly kind: "enabled";
  readonly maxActiveCases: number;
  readonly maxMessagesPerHour: number;
  readonly dailyTokenBudget: number;
  readonly maxMessageBytes: number;
  readonly maxAttachmentBytes: number;
  readonly debounce: {
    readonly kind: "push_triggered";
    readonly coalesceSeconds: 30;
  };
  readonly overflow: "pause_and_notify";
} {
  return {
    kind: "enabled",
    maxActiveCases: 3,
    maxMessagesPerHour: 20,
    dailyTokenBudget: 250_000,
    maxMessageBytes: 262_144,
    maxAttachmentBytes: 5_242_880,
    debounce: { kind: "push_triggered", coalesceSeconds: 30 },
    overflow: "pause_and_notify",
  };
}

function requireCaseId(raw: string): ReturnType<typeof requireCaseIdValue> {
  return requireCaseIdValue(raw);
}
