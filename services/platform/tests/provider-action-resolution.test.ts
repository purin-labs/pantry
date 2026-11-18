import type { SingleDatabase } from "../src/database-handles";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
import { requireOrganisationBootstrap } from "./organisation-execution-fixture";
import { describe, expect, it } from "vitest";

import {
  authorizeProviderActionResolution,
  resolveProviderActionCredential,
  storeVaultSecret,
  type AuthorizedProviderAction,
  type VaultHandle,
} from "../src/credential-vault";
import { upsertUser } from "../src/data/control-plane";
import {
  createConnectedIntegration,
  setIntegrationAccountLifecycle,
  type ConnectedIntegration,
  type ConnectedIntegrationSeed,
} from "../src/data/integration-account";
import {
  parseApprovalProofDigest,
  type ApprovalEvidence,
} from "../src/approval-authentication";
import {
  parseCaseId,
  parseUserId,
  parseControlSessionId,
  parsePersonId,
  parseSessionId,
  parseOrganisationId,
  type UserId,
  type SessionId,
  type OrganisationId,
} from "../src/ids";
import { credentialPolicyRuleId } from "../src/policy-rule-id";
import {
  compilePublishAndActivateOrganisationPolicy,
  type OrganisationPolicySnapshot,
  writeStripeReadCredentialRef,
} from "../src/policy-snapshot";
import { organisationBootstrapMutation } from "./control-mutation-fixture";
import { TEST_INITIAL_ORGANISATION_PLACEMENT } from "./fixtures/organisation-placement";
import {
  fixtureFlowBinding,
  fixtureProviderActionAuthority,
} from "./fixtures/plan25-turn";
import { createMigratedDatabase } from "./sqlite-d1";
import { requireVaultHandle } from "./test-ids";
import { testRoot } from "./secrets-store";
const NOW = 1_785_045_600_000;

describe(
  "provider action credential resolution",
  providerActionResolutionSuite,
);

function providerActionResolutionSuite(): void {
  it(
    "resolves only the active generation for an approved action",
    resolvesApprovedAction,
  );
  it(
    "rejects a provider that does not match the approved route",
    rejectsProviderMismatch,
  );
  it(
    "rejects an action whose organisation does not own the account",
    rejectsCrossOrganisationAction,
  );
  it("rejects cross-environment account reuse", rejectsEnvironmentDrift);
  it(
    "rechecks generation lifecycle immediately before decrypt",
    rejectsStaleGeneration,
  );
  it(
    "compiles raw rules only from an active account generation",
    compilesScopedHarnessRule,
  );
}

async function resolvesApprovedAction(): Promise<void> {
  const fixture = await createFixture();
  const action = signedAction(
    fixture.organisationId,
    fixture.connection,
    fixture.sessionId,
  );
  const authorization = await authorizeProviderActionResolution({
    db: fixture.db,
    action,
    expectedProvider: "stripe",
  });

  expect(authorization).toMatchObject({
    ok: true,
    value: {
      kind: "provider_action",
      organisationId: fixture.organisationId,
      integrationAccountId: fixture.connection.account.integrationAccountId,
      provider: "stripe",
      environment: "development",
      credentialGeneration: 1,
      handle: fixture.handle,
      providerAccountId: "acct_action_resolution",
    },
  });

  if (!authorization.ok) {
    throw new Error(authorization.error.code);
  }

  await expect(
    resolveProviderActionCredential({
      db: fixture.db,
      keys: fixture.keys,
      authorization: authorization.value,
    }),
  ).resolves.toEqual({
    ok: true,
    value: { kind: "bearer", value: "sk_test_action_resolution" },
  });
}

async function rejectsProviderMismatch(): Promise<void> {
  const fixture = await createFixture();

  await expect(
    authorizeProviderActionResolution({
      db: fixture.db,
      action: signedAction(
        fixture.organisationId,
        fixture.connection,
        fixture.sessionId,
      ),
      expectedProvider: "shopify",
    }),
  ).resolves.toEqual({
    ok: false,
    error: {
      code: "provider_scope_mismatch",
      expected: "shopify",
      actual: "stripe",
    },
  });
}

async function rejectsCrossOrganisationAction(): Promise<void> {
  const fixture = await createFixture();
  const otherOrganisation = await createOrganisation(
    fixture.db,
    "cross-organisation-owner",
    "cross-organisation@example.com",
    "Cross Organisation",
  );

  await expect(
    authorizeProviderActionResolution({
      db: fixture.db,
      action: signedAction(
        otherOrganisation,
        fixture.connection,
        fixture.sessionId,
      ),
      expectedProvider: "stripe",
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "integration_account_not_found" },
  });
}

async function rejectsEnvironmentDrift(): Promise<void> {
  const fixture = await createFixture();
  await fixture.db
    .prepare(
      "UPDATE organisation_onboarding SET environment = 'production' WHERE organisation_id = ?",
    )
    .bind(fixture.organisationId)
    .run();

  await expect(
    authorizeProviderActionResolution({
      db: fixture.db,
      action: signedAction(
        fixture.organisationId,
        fixture.connection,
        fixture.sessionId,
      ),
      expectedProvider: "stripe",
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "environment_mismatch" },
  });
}

async function rejectsStaleGeneration(): Promise<void> {
  const fixture = await createFixture();
  const authorization = await authorizeProviderActionResolution({
    db: fixture.db,
    action: signedAction(
      fixture.organisationId,
      fixture.connection,
      fixture.sessionId,
    ),
    expectedProvider: "stripe",
  });

  if (!authorization.ok) {
    throw new Error(authorization.error.code);
  }

  await supersedeActiveGeneration(fixture);

  await expect(
    resolveProviderActionCredential({
      db: fixture.db,
      keys: fixture.keys,
      authorization: authorization.value,
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "credential_generation_inactive" },
  });
}

async function compilesScopedHarnessRule(): Promise<void> {
  const fixture = await createFixture();
  const rule = await writeHarnessRule(fixture);
  const kv = new TestKvNamespace();
  const active = await compilePublishAndActivateOrganisationPolicy({
    bindings: {
      db: fixture.db,
      kv: kv as unknown as KVNamespace,
    },
    organisationId: fixture.organisationId,
    organisation: new TestOrganisationPolicyActivator(),
    now: NOW,
  });

  expect(active).toMatchObject({
    ok: true,
    value: {
      snapshot: {
        egress: {
          injections: [rule],
        },
      },
    },
  });

  await supersedeActiveGeneration(fixture);

  const stale = await compilePublishAndActivateOrganisationPolicy({
    bindings: {
      db: fixture.db,
      kv: kv as unknown as KVNamespace,
    },
    organisationId: fixture.organisationId,
    organisation: new TestOrganisationPolicyActivator(),
    now: NOW + 1,
  });

  expect(stale).toMatchObject({
    ok: true,
    value: {
      snapshot: {
        egress: {
          injections: [],
        },
      },
    },
  });
}

type ProviderActionFixture = {
  readonly db: SingleDatabase;
  readonly organisationId: OrganisationId;
  readonly sessionId: SessionId;
  readonly connection: ConnectedIntegration;
  readonly handle: VaultHandle;
  readonly keys: {
    readonly SATYR_VAULT_ACTIVE_KEY_VERSION: "v1";
    readonly VAULT_ROOT_V1: SecretsStoreSecret;
  };
};

async function createFixture(): Promise<ProviderActionFixture> {
  const db = createMigratedDatabase();
  const organisationId = await createOrganisation(
    db,
    "provider-action-owner",
    "provider-action@example.com",
    "Provider Action",
  );
  await activateOrganisationOnboarding(db, organisationId);
  const owner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "provider-action-owner",
      email: "provider-action@example.com",
      displayName: "Provider Action Owner",
      emailVerified: true,
    },
    now: NOW,
  });
  const handle = requireVaultHandle(
    "vault:organisation:stripe:acct_action_resolution:oauth:g1",
  );
  const keys = {
    SATYR_VAULT_ACTIVE_KEY_VERSION: "v1" as const,
    VAULT_ROOT_V1: testRoot(7),
  };
  const stored = await storeVaultSecret({
    db,
    keys,
    organisationId,
    handle,
    secret: { kind: "bearer", value: "sk_test_action_resolution" },
    now: NOW,
  });

  if (!stored.ok) {
    throw new Error(stored.error.code);
  }

  const connection = await createConnectedIntegration(
    db,
    stripeSeed(organisationId, owner.userId, handle),
  );
  await setIntegrationAccountLifecycle({
    db,
    organisationId,
    integrationAccountId: connection.account.integrationAccountId,
    lifecycle: { kind: "active" },
    now: NOW,
  });
  const sessionId = parseSessionId("session_provider_action_resolution");

  if (!sessionId.ok) {
    throw new Error(sessionId.error.code);
  }

  return {
    db,
    organisationId,
    sessionId: sessionId.value,
    connection,
    handle,
    keys,
  };
}

async function activateOrganisationOnboarding(
  db: SingleDatabase,
  organisationId: OrganisationId,
): Promise<void> {
  await db
    .prepare(
      `UPDATE organisation_onboarding
       SET lifecycle = 'active',
           activation_receipt_id = 'activation_provider_action_resolution',
           activated_at = ?,
           updated_at = ?
       WHERE organisation_id = ?`,
    )
    .bind(NOW, NOW, organisationId)
    .run();
}

async function writeHarnessRule(fixture: ProviderActionFixture): Promise<{
  readonly ruleId: string;
  readonly hostPattern: string;
  readonly credentialRef: string;
  readonly mode: {
    readonly kind: "header";
    readonly header: string;
    readonly scheme: string;
  };
}> {
  await writeStripeReadCredentialRef({
    db: fixture.db,
    organisationId: fixture.organisationId,
    vaultHandle: fixture.handle,
    now: NOW,
  });
  const source = {
    provider: "stripe",
    name: "read",
    integrationAccountId: fixture.connection.account.integrationAccountId,
    providerConnectionId: fixture.connection.connection.providerConnectionId,
    environment: "development",
    credentialGeneration: 1,
    vaultHandle: fixture.handle,
    hostPattern: "api.stripe.com",
    injectAs: JSON.stringify({
      kind: "header",
      header: "authorization",
      scheme: "Bearer",
    }),
  };

  return {
    ruleId: await credentialPolicyRuleId(source),
    hostPattern: source.hostPattern,
    credentialRef: fixture.handle,
    mode: {
      kind: "header",
      header: "authorization",
      scheme: "Bearer",
    },
  };
}

async function supersedeActiveGeneration(
  fixture: ProviderActionFixture,
): Promise<void> {
  await fixture.db
    .prepare(
      `UPDATE provider_credential_generation
       SET lifecycle = 'superseded', superseded_at = ?
       WHERE provider_connection_id = ? AND credential_generation = 1`,
    )
    .bind(NOW + 1, fixture.connection.connection.providerConnectionId)
    .run();
}

async function createOrganisation(
  db: SingleDatabase,
  subject: string,
  email: string,
  organisationName: string,
): Promise<OrganisationId> {
  const owner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject,
      email,
      displayName: organisationName,
      emailVerified: true,
    },
    now: NOW,
  });
  const organisation = await requireOrganisationBootstrap({
    env: {
      DB: db,
      SATYR_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    owner,
    organisationName,
    environment: "development",
    mutation: organisationBootstrapMutation(owner, NOW),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: NOW,
  });

  return organisation.organisationId;
}

function stripeSeed(
  organisationId: OrganisationId,
  userId: UserId,
  credentialRef: VaultHandle,
): ConnectedIntegrationSeed {
  return {
    organisationId,
    provider: "stripe",
    providerSubjectId: "acct_action_resolution",
    environment: "development",
    authMode: "shared_satyr_app",
    authority: { kind: "connection_credential", credentialRef },
    grantedScopes: ["read_write"],
    createdByUserId: userId,
    providerAccountId: "acct_action_resolution",
    accountKind: "merchant_account",
    displayName: "Stripe action account",
    capabilities: ["payments.read", "refunds.propose"],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now: NOW,
  };
}

function signedAction(
  organisationId: OrganisationId,
  connection: ConnectedIntegration,
  sessionId: SessionId,
): AuthorizedProviderAction {
  const caseId = parseCaseId("case_provider_action");
  if (!caseId.ok) throw new Error(caseId.error.code);
  const authority = fixtureProviderActionAuthority({
    organisationId,
    integrationAccountId: connection.account.integrationAccountId,
    providerResourceScope: "stripe:charge.create",
  });
  return {
    caseId: caseId.value,
    proposalId: "proposal_provider_action",
    commerceEffect: null,
    state: "executing",
    action: {
      organisationId,
      integrationAccountId: connection.account.integrationAccountId,
      requestAuthority: authority.requestAuthority,
      authorityPartition: authority.authorityPartition,
      authority: { kind: "integration_account" },
      sessionId,
      threadId: "slack:T:C:provider-action",
      host: "api.stripe.com",
      verb: "stripe.charge.create",
      path: "/v1/charges",
      argsHash: "provider-action-args",
      amount: { value: 100, currency: "USD" },
      nonce: { value: "provider-action-nonce" },
      exp: NOW + 60_000,
      resourceKey: "stripe:charge.create",
      flowBinding: fixtureFlowBinding({
        organisationId,
        sessionId,
        authorityPartitionDigest: authority.authorityPartition.digest,
      }),
    },
    approval: approvalEvidence(),
    executionLease: {
      leaseId: "lease_provider_action",
      expiresAt: NOW + 30_000,
    },
    idempotencyKey: "provider-action-idempotency",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function approvalEvidence(): ApprovalEvidence {
  const userId = parseUserId("user_37fb6ad1-2d71-5aec-a71c-ba06fd27a7d4");
  const controlSessionId = parseControlSessionId(
    "control_session_provider_action",
  );
  const personId = parsePersonId("person_provider_action");
  const organisationId = parseOrganisationId("organisation_provider_action");
  const actionDigest = parseApprovalProofDigest("00".repeat(32));
  if (
    !userId.ok ||
    !controlSessionId.ok ||
    !personId.ok ||
    !organisationId.ok ||
    actionDigest === null
  ) {
    throw new Error("invalid approval fixture");
  }
  return {
    kind: "app_user",
    principal: {
      kind: "app_user",
      userId: userId.value,
      personId: personId.value,
      role: "owner",
    },
    authentication: {
      kind: "google_oidc_step_up",
      controlSessionId: controlSessionId.value,
      authenticatedAt: NOW,
      challenge: {
        stepUpId: "fixture:provider_action",
        organisationId: organisationId.value,
        actionNonce: "action_provider_action",
        actionDigest,
        policy: { kind: "unversioned_default" },
        issuedAt: NOW,
        expiresAt: NOW + 600_000,
      },
    },
  };
}

class TestKvNamespace {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

class TestOrganisationPolicyActivator {
  async activatePolicy(
    input: Readonly<{ readonly snapshot: OrganisationPolicySnapshot }>,
  ) {
    return {
      ok: true as const,
      value: {
        head: {
          activeVersion: input.snapshot.version,
          restrictionVersion: input.snapshot.version,
          digest: await testPolicyDigest(input.snapshot),
        },
        consumers: 0,
        delivered: 0,
        pending: 0,
      },
    };
  }
}

async function testPolicyDigest(
  snapshot: OrganisationPolicySnapshot,
): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const value of digest) hex += value.toString(16).padStart(2, "0");
  return hex;
}
