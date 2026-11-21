import type { SingleDatabase } from "../src/database-handles";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
import { requireOrganisationBootstrap } from "./organisation-execution-fixture";
import { describe, expect, it } from "vitest";

import { upsertUser } from "../src/data/control-plane";
import {
  createConnectedIntegration,
  setIntegrationAccountLifecycle,
  type ConnectedIntegrationSeed,
} from "../src/data/integration-account";
import type {
  OrganisationActivatePolicyInput,
  OrganisationPolicyActivation,
} from "../src/actors/organisation/policy-types";
import type { UserId, ProviderConnectionId, OrganisationId } from "../src/ids";
import {
  writeStripeReadCredentialRef,
  type OrganisationPolicySnapshot,
} from "../src/policy-snapshot";
import {
  activateProviderCredentialCutover,
  reconcileInterruptedProviderCredentialCutovers,
} from "../src/integrations/contract/credential-cutover";
import type { Result } from "../src/result";
import { storeVaultSecret, type VaultHandle } from "../src/credential-vault";
import { organisationBootstrapMutation } from "./control-mutation-fixture";
import { TEST_INITIAL_ORGANISATION_PLACEMENT } from "./fixtures/organisation-placement";
import { testRoot } from "./secrets-store";
import { createMigratedDatabase } from "./sqlite-d1";
import { requireVaultHandle } from "./test-ids";

const NOW = 1_784_500_000_000;

describe("provider credential cutover", providerCredentialCutoverSuite);

function providerCredentialCutoverSuite(): void {
  it(
    "activates policy for the replacement before revoking the superseded credential",
    rotatesProviderCredential,
  );
  it(
    "keeps the superseded Vault row available for retry when policy activation fails",
    preservesSupersededCredentialAfterActivationFailure,
  );
  it(
    "reconciles an interrupted credential cutover exactly once",
    reconcilesInterruptedCredentialCutover,
  );
}

async function rotatesProviderCredential(): Promise<void> {
  const fixture = await createCutoverFixture();
  await expect(
    activeCredentialRef(fixture.db, fixture.organisationId),
  ).resolves.toBe(fixture.newHandle);

  const organisationActivator = new TestOrganisationPolicyActivator(
    fixture.db,
    fixture.organisationId,
    fixture.oldHandle,
  );
  const kv = new TestKvNamespace();
  const cutover = await activateProviderCredentialCutover({
    db: fixture.db,
    kv: kv.binding(),
    organisation: organisationActivator,
    organisationId: fixture.organisationId,
    providerConnectionId: fixture.providerConnectionId,
    now: NOW + 2,
  });

  expect(cutover).toEqual({ ok: true, value: true });
  expect(organisationActivator.snapshots).toHaveLength(1);
  expect(organisationActivator.snapshots[0]?.egress.injections).toEqual([
    expect.objectContaining({ credentialRef: fixture.newHandle }),
  ]);
  await expect(
    credentialState(fixture.db, fixture.organisationId, fixture.oldHandle),
  ).resolves.toEqual({ lifecycle: "revoked", revokedAt: NOW + 2 });
  await expect(
    vaultRevokedAt(fixture.db, fixture.organisationId, fixture.oldHandle),
  ).resolves.toBe(NOW + 2);
  await expect(
    credentialState(fixture.db, fixture.organisationId, fixture.newHandle),
  ).resolves.toEqual({ lifecycle: "active", revokedAt: null });
  await expect(
    vaultRevokedAt(fixture.db, fixture.organisationId, fixture.newHandle),
  ).resolves.toBeNull();
}

async function preservesSupersededCredentialAfterActivationFailure(): Promise<void> {
  const fixture = await createCutoverFixture();
  const cutover = await activateProviderCredentialCutover({
    db: fixture.db,
    kv: new TestKvNamespace().binding(),
    organisation: new RejectingOrganisationPolicyActivator(),
    organisationId: fixture.organisationId,
    providerConnectionId: fixture.providerConnectionId,
    now: NOW + 2,
  });

  expect(cutover).toEqual({
    ok: false,
    error: { code: "provider_policy_activation_failed" },
  });
  await expect(
    credentialState(fixture.db, fixture.organisationId, fixture.oldHandle),
  ).resolves.toEqual({ lifecycle: "superseded", revokedAt: null });
  await expect(
    vaultRevokedAt(fixture.db, fixture.organisationId, fixture.oldHandle),
  ).resolves.toBeNull();
}

async function reconcilesInterruptedCredentialCutover(): Promise<void> {
  const fixture = await createCutoverFixture();
  const kv = new TestKvNamespace();
  const interrupted = await activateProviderCredentialCutover({
    db: fixture.db,
    kv: kv.binding(),
    organisation: new RejectingOrganisationPolicyActivator(),
    organisationId: fixture.organisationId,
    providerConnectionId: fixture.providerConnectionId,
    now: NOW + 2,
  });
  expect(interrupted.ok).toBe(false);

  const organisationActivator = new TestOrganisationPolicyActivator(
    fixture.db,
    fixture.organisationId,
    fixture.oldHandle,
  );
  const reconciled = await reconcileInterruptedProviderCredentialCutovers({
    db: fixture.db,
    kv: kv.binding(),
    organisation: organisationActivator,
    organisationId: fixture.organisationId,
    now: NOW + 3,
  });

  expect(reconciled).toEqual({ ok: true, value: 1 });
  expect(organisationActivator.snapshots).toHaveLength(1);
  await expect(
    credentialState(fixture.db, fixture.organisationId, fixture.oldHandle),
  ).resolves.toEqual({ lifecycle: "revoked", revokedAt: NOW + 3 });
  await expect(
    vaultRevokedAt(fixture.db, fixture.organisationId, fixture.oldHandle),
  ).resolves.toBe(NOW + 3);
  await expect(
    activeGenerationCount(fixture.db, fixture.providerConnectionId),
  ).resolves.toBe(1);

  await expect(
    reconcileInterruptedProviderCredentialCutovers({
      db: fixture.db,
      kv: kv.binding(),
      organisation: organisationActivator,
      organisationId: fixture.organisationId,
      now: NOW + 4,
    }),
  ).resolves.toEqual({ ok: true, value: 0 });
  expect(organisationActivator.snapshots).toHaveLength(1);
}

type CutoverFixture = {
  readonly db: SingleDatabase;
  readonly organisationId: OrganisationId;
  readonly providerConnectionId: ProviderConnectionId;
  readonly oldHandle: VaultHandle;
  readonly newHandle: VaultHandle;
};

async function createCutoverFixture(): Promise<CutoverFixture> {
  const db = createMigratedDatabase();
  const owner = await createOrganisationOwner(db);
  const organisation = await requireOrganisationBootstrap({
    env: {
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE:
        TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    owner,
    organisationName: "Credential Cutover",
    environment: "development",
    mutation: organisationBootstrapMutation(owner, NOW),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: NOW,
  });
  await activateOrganisationOnboarding(db, organisation.organisationId);
  const oldHandle = requireVaultHandle(
    "vault:organisation:stripe:acct_cutover:oauth:g1",
  );
  const newHandle = requireVaultHandle(
    "vault:organisation:stripe:acct_cutover:oauth:g2",
  );
  const keys = {
    PANTRY_VAULT_ACTIVE_KEY_VERSION: "v1" as const,
    VAULT_ROOT_V1: testRoot(9),
  };
  await storeCredential(
    db,
    keys,
    organisation.organisationId,
    oldHandle,
    "sk_test_old",
    NOW,
  );
  const first = await createConnectedIntegration(
    db,
    stripeSeed(organisation.organisationId, owner.userId, oldHandle, NOW),
  );
  await setIntegrationAccountLifecycle({
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: first.account.integrationAccountId,
    lifecycle: { kind: "active" },
    now: NOW,
  });
  await writeStripeReadCredentialRef({
    db,
    organisationId: organisation.organisationId,
    vaultHandle: oldHandle,
    now: NOW,
  });
  await storeCredential(
    db,
    keys,
    organisation.organisationId,
    newHandle,
    "sk_test_new",
    NOW + 1,
  );
  const replacement = await createConnectedIntegration(
    db,
    stripeSeed(organisation.organisationId, owner.userId, newHandle, NOW + 1),
  );
  return {
    db,
    organisationId: organisation.organisationId,
    providerConnectionId: replacement.connection.providerConnectionId,
    oldHandle,
    newHandle,
  };
}

async function createOrganisationOwner(db: SingleDatabase) {
  return upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "credential-cutover-owner",
      email: "credential-cutover@example.com",
      displayName: "Credential Cutover Owner",
      emailVerified: true,
    },
    now: NOW,
  });
}

async function activateOrganisationOnboarding(
  db: SingleDatabase,
  organisationId: OrganisationId,
): Promise<void> {
  await db
    .prepare(
      `UPDATE organisation_onboarding
       SET lifecycle = 'active',
           activation_receipt_id = 'activation_credential_cutover',
           activated_at = ?,
           updated_at = ?
       WHERE organisation_id = ?`,
    )
    .bind(NOW, NOW, organisationId)
    .run();
}

async function storeCredential(
  db: SingleDatabase,
  keys: {
    readonly PANTRY_VAULT_ACTIVE_KEY_VERSION: "v1";
    readonly VAULT_ROOT_V1: SecretsStoreSecret;
  },
  organisationId: OrganisationId,
  handle: VaultHandle,
  value: string,
  now: number,
): Promise<void> {
  const stored = await storeVaultSecret({
    db,
    keys,
    organisationId,
    handle,
    secret: { kind: "bearer", value },
    now,
  });
  if (!stored.ok) {
    throw new Error(stored.error.code);
  }
}

function stripeSeed(
  organisationId: OrganisationId,
  userId: UserId,
  credentialRef: VaultHandle,
  now: number,
): ConnectedIntegrationSeed {
  return {
    organisationId,
    provider: "stripe",
    providerSubjectId: "acct_cutover",
    environment: "development",
    authMode: "shared_satyr_app",
    authority: { kind: "connection_credential", credentialRef },
    grantedScopes: ["read_write"],
    createdByUserId: userId,
    providerAccountId: "acct_cutover",
    accountKind: "merchant_account",
    displayName: "Credential Cutover",
    capabilities: ["payments.read"],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now,
  };
}

async function activeCredentialRef(
  db: SingleDatabase,
  organisationId: OrganisationId,
): Promise<unknown> {
  const row = await db
    .prepare(
      `SELECT vault_handle AS vaultHandle
       FROM credential_ref
       WHERE organisation_id = ? AND provider = 'stripe' AND name = 'read'`,
    )
    .bind(organisationId)
    .first<{ readonly vaultHandle: unknown }>();
  return row?.vaultHandle;
}

async function credentialState(
  db: SingleDatabase,
  organisationId: OrganisationId,
  handle: VaultHandle,
): Promise<{ readonly lifecycle: unknown; readonly revokedAt: unknown }> {
  const row = await db
    .prepare(
      `SELECT lifecycle, revoked_at AS revokedAt
       FROM provider_credential_generation
       WHERE organisation_id = ? AND credential_ref = ?`,
    )
    .bind(organisationId, handle)
    .first<{ readonly lifecycle: unknown; readonly revokedAt: unknown }>();
  if (row === null) {
    throw new Error("credential generation missing");
  }
  return row;
}

async function vaultRevokedAt(
  db: SingleDatabase,
  organisationId: OrganisationId,
  handle: VaultHandle,
): Promise<unknown> {
  const row = await db
    .prepare(
      `SELECT revoked_at AS revokedAt
       FROM vault_secret
       WHERE organisation_id = ? AND vault_handle = ?`,
    )
    .bind(organisationId, handle)
    .first<{ readonly revokedAt: unknown }>();
  return row?.revokedAt;
}

async function activeGenerationCount(
  db: SingleDatabase,
  providerConnectionId: ProviderConnectionId,
): Promise<unknown> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM provider_credential_generation
       WHERE provider_connection_id = ? AND lifecycle = 'active'`,
    )
    .bind(providerConnectionId)
    .first<{ readonly count: unknown }>();
  return row?.count;
}

class TestOrganisationPolicyActivator {
  readonly snapshots: OrganisationPolicySnapshot[] = [];

  constructor(
    private readonly db: SingleDatabase,
    private readonly organisationId: OrganisationId,
    private readonly oldHandle: VaultHandle,
  ) {}

  async activatePolicy(
    input: OrganisationActivatePolicyInput,
  ): Promise<
    Result<
      OrganisationPolicyActivation,
      { readonly code: "invalid_policy_snapshot" }
    >
  > {
    expect(input.organisationId).toBe(this.organisationId);
    await expect(
      vaultRevokedAt(this.db, this.organisationId, this.oldHandle),
    ).resolves.toBeNull();
    this.snapshots.push(input.snapshot);
    return {
      ok: true,
      value: {
        head: {
          activeVersion: input.snapshot.version,
          restrictionVersion: input.snapshot.version,
          digest: await policyDigest(input.snapshot),
          activatedAt: input.activatedAt,
        },
        consumers: 0,
        delivered: 0,
        pending: 0,
      },
    };
  }
}

class RejectingOrganisationPolicyActivator {
  async activatePolicy(
    _input: OrganisationActivatePolicyInput,
  ): Promise<
    Result<
      OrganisationPolicyActivation,
      { readonly code: "invalid_policy_snapshot" }
    >
  > {
    return { ok: false, error: { code: "invalid_policy_snapshot" } };
  }
}

class TestKvNamespace {
  private readonly values = new Map<string, string>();

  binding(): KVNamespace {
    return this as unknown as KVNamespace;
  }

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

async function policyDigest(
  snapshot: OrganisationPolicySnapshot,
): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const value of digest) hex += value.toString(16).padStart(2, "0");
  return hex;
}
