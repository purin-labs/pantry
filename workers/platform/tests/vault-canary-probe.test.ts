// The ports that the Worker registers (worker-ports.ts).
import "../src/worker-ports";
import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  authorizeProviderActionResolution,
  parseVaultHandle,
  resolveAccountRemovalCredential,
  resolveActiveProviderConnectionCredential,
  resolveDiscordInteractionVerificationCredential,
  resolveProviderActionCredential,
  resolveProviderManifestCredential,
  resolveProviderWebhookCredential,
  resolveSurfaceInstallationCredential,
  revokeVaultSecret,
  storeVaultSecret,
  verifyStoredVaultSecret,
  type AuthorizedProviderAction,
  type VaultHandle,
  type VaultStoredSecret,
} from "@purin-labs/authority/credential-vault/index";
import type { CredentialVaultBindings } from "@purin-labs/authority/credential-vault/keyring";
import {
  parseApprovalProofDigest,
  type ApprovalEvidence,
} from "@purin-labs/authority/approval-authentication";
import {
  parseDiscordApplicationId,
  parseDiscordGuildId,
  type DiscordInteractionInstall,
} from "@purin-labs/area-integrations/server/data/discord-install";
import {
  resolveActiveProviderAccountContext,
  type ActiveProviderAccountContext,
  type IntegrationProvider,
  type LiveProviderWebhookContext,
} from "@purin-labs/connections/data/integration-account";
import type { OrganisationInstallRecord } from "@purin-labs/tenancy/data/organisation";
import {
  parseCaseId,
  parseControlSessionId,
  parseIntegrationAccountId,
  parsePersonId,
  parseProviderConnectionId,
  parseSessionId,
  parseOrganisationId,
  parseWorkspaceId,
  type IntegrationAccountId,
  type ProviderConnectionId,
  type SessionId,
  type OrganisationId,
  type WorkspaceId,
} from "@purin-labs/kernel/ids";
import { parseUserId } from "@purin-labs/control-api/ids";
import { parseOrganisationPlacement } from "@purin-labs/tenancy/placement";
import type { Result } from "@purin-labs/kernel/result";
import { d1Database } from "./sqlite-d1";
import {
  fixtureFlowBinding,
  fixtureProviderActionAuthority,
} from "./fixtures/plan25-turn";
import { testRoot } from "./secrets-store";
const NOW = 10_000;
const CANARY_ALPHA = `canary-secret-${randomHex(16)}`;
const CANARY_BETA = `canary-secret-${randomHex(16)}`;
const CORRUPTED_CIPHERTEXT_B64 = btoa(
  "corrupted-canary-ciphertext-probe-payload",
);
const CONCURRENT_PROBE_COUNT = 32;

describe("Plan 12 V6 malicious-harness canary probes", canaryProbeSuite);

function canaryProbeSuite(): void {
  it(
    "seeds per-organisation canaries into a full credential graph without leaking plaintext",
    canarySeedingProbe,
  );
  it(
    "denies every forged or mismatched scope without carrying the canary",
    deniedSurfacesProbe,
  );
  it(
    "keeps the canary out of console logs during probe operations",
    logSurfaceProbe,
  );
  it(
    "keeps the canary plaintext out of every durable row after legitimate resolution",
    durableRowProbe,
  );
  it(
    "returns typed errors without canary or ciphertext fragments on corrupted ciphertext",
    errorPathProbe,
  );
  it(
    "isolates 32 interleaved concurrent cross-organisation resolutions",
    concurrentIsolationProbe,
  );
}

async function canarySeedingProbe(): Promise<void> {
  const fixture = await createFixture();
  const signatures = probeSignatures();

  expect(fixture.receipts).toHaveLength(6);
  for (const receipt of fixture.receipts) {
    assertCarriesNoCanary(JSON.stringify(receipt), signatures);
  }

  await expect(
    verifyStoredVaultSecret({
      db: fixture.db,
      keys: fixture.keys,
      stored: requireReceipt(fixture, fixture.alpha.stripe.credentialRef),
      expected: { kind: "bearer", value: CANARY_ALPHA },
    }),
  ).resolves.toEqual({ ok: true, value: true });
  await expect(
    verifyStoredVaultSecret({
      db: fixture.db,
      keys: fixture.keys,
      stored: requireReceipt(fixture, fixture.beta.stripe.credentialRef),
      expected: { kind: "bearer", value: CANARY_BETA },
    }),
  ).resolves.toEqual({ ok: true, value: true });

  const row = await readCanaryRow(
    fixture,
    fixture.alpha.organisationId,
    fixture.alpha.stripe.credentialRef,
  );
  expect(row.ciphertextB64.length).toBeGreaterThan(0);
  assertCarriesNoCanary(row.ciphertextB64, signatures);
}

async function deniedSurfacesProbe(): Promise<void> {
  const fixture = await createFixture();
  const signatures = probeSignatures();
  const denials: string[] = [];

  const actionAuthorization = await authorizeProviderActionResolution({
    db: fixture.db,
    action: signedAction(
      fixture.alpha.organisationId,
      fixture.alpha.stripe.integrationAccountId,
      fixture.alpha.sessionId,
    ),
    expectedProvider: "stripe",
  });
  if (!actionAuthorization.ok) {
    throw new Error(actionAuthorization.error.code);
  }

  const connectionContext = await activeProviderContext(
    fixture.db,
    fixture.alpha.organisationId,
    fixture.alpha.stripe,
  );

  denials.push(
    expectDenied(
      await resolveProviderWebhookCredential({
        db: fixture.db,
        keys: fixture.keys,
        organisationId: fixture.alpha.organisationId,
        provider: "stripe",
        context: providerWebhookContext(fixture, "acct_canary_forged"),
      }),
      "webhook_binding_inactive",
    ),
  );

  denials.push(
    expectDenied(
      await resolveDiscordInteractionVerificationCredential({
        db: fixture.db,
        keys: fixture.keys,
        install: discordInstall(fixture, "999999999999999999"),
      }),
      "webhook_binding_inactive",
    ),
  );

  denials.push(
    expectDenied(
      await resolveProviderManifestCredential({
        ...manifestRequest(fixture, fixture.alpha),
        organisationId: fixture.beta.organisationId,
      }),
      "provider_manifest_scope_inactive",
    ),
  );

  denials.push(
    expectDenied(
      await resolveProviderManifestCredential({
        ...manifestRequest(fixture, fixture.alpha),
        environment: "production",
      }),
      "provider_manifest_scope_inactive",
    ),
  );

  denials.push(
    expectDenied(
      await resolveSurfaceInstallationCredential({
        db: fixture.db,
        keys: fixture.keys,
        install: surfaceInstall(
          fixture,
          requireOk(parseWorkspaceId("workspace_canary_forged")),
        ),
      }),
      "surface_installation_inactive",
    ),
  );

  denials.push(
    expectDenied(
      await resolveAccountRemovalCredential({
        db: fixture.db,
        keys: fixture.keys,
        cleanupId: "cleanup_canary_alpha",
        organisationId: fixture.alpha.organisationId,
        integrationAccountId: fixture.alpha.stripe.integrationAccountId,
        provider: "stripe",
        environment: "development",
        providerAccountId: fixture.alpha.stripe.providerAccountId,
        providerConnectionId: fixture.alpha.stripe.providerConnectionId,
        handle: fixture.alpha.stripe.credentialRef,
      }),
      "account_removal_scope_inactive",
    ),
  );

  denials.push(
    expectDenied(
      await authorizeProviderActionResolution({
        db: fixture.db,
        action: signedAction(
          fixture.beta.organisationId,
          fixture.alpha.stripe.integrationAccountId,
          fixture.alpha.sessionId,
        ),
        expectedProvider: "stripe",
      }),
      "integration_account_not_found",
    ),
  );

  await setStripeGenerationLifecycle(fixture, "superseded");

  denials.push(
    expectDenied(
      await resolveProviderActionCredential({
        db: fixture.db,
        keys: fixture.keys,
        authorization: actionAuthorization.value,
      }),
      "credential_generation_inactive",
    ),
  );

  denials.push(
    expectDenied(
      await resolveActiveProviderConnectionCredential({
        db: fixture.db,
        keys: fixture.keys,
        context: connectionContext,
        expectedProvider: "stripe",
      }),
      "provider_connection_scope_inactive",
    ),
  );

  await setStripeGenerationLifecycle(fixture, "active");
  await revokeVaultSecret({
    db: fixture.db,
    organisationId: fixture.alpha.organisationId,
    handle: fixture.alpha.stripe.credentialRef,
    now: NOW + 2,
  });

  denials.push(
    expectDenied(
      await resolveProviderManifestCredential(
        manifestRequest(fixture, fixture.alpha),
      ),
      "vault_secret_revoked",
    ),
  );

  expect(denials).toHaveLength(10);
  const ciphertexts = await readVaultCiphertexts(fixture.db);
  expect(ciphertexts.length).toBeGreaterThan(0);
  for (const denial of denials) {
    assertCarriesNoCanary(denial, signatures);
    for (const ciphertext of ciphertexts) {
      expect(denial).not.toContain(ciphertext);
    }
  }
}

async function logSurfaceProbe(): Promise<void> {
  const captured: string[] = [];
  const capture = (...values: unknown[]): void => {
    captured.push(values.map(renderLogValue).join(" "));
  };
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  console.log = capture;
  console.warn = capture;
  console.error = capture;

  try {
    const fixture = await createFixture();

    await expect(
      resolveProviderManifestCredential(
        manifestRequest(fixture, fixture.alpha),
      ),
    ).resolves.toEqual({
      ok: true,
      value: { kind: "bearer", value: CANARY_ALPHA },
    });

    expectDenied(
      await resolveProviderWebhookCredential({
        db: fixture.db,
        keys: fixture.keys,
        organisationId: fixture.alpha.organisationId,
        provider: "stripe",
        context: providerWebhookContext(fixture, "acct_canary_forged"),
      }),
      "webhook_binding_inactive",
    );

    await corruptCiphertext(
      fixture.db,
      fixture.alpha.organisationId,
      fixture.alpha.webhookHandle,
    );
    expectDenied(
      await resolveProviderWebhookCredential({
        db: fixture.db,
        keys: fixture.keys,
        organisationId: fixture.alpha.organisationId,
        provider: "stripe",
        context: providerWebhookContext(
          fixture,
          fixture.alpha.stripe.providerAccountId,
        ),
      }),
      "vault_ciphertext_invalid",
    );

    await revokeVaultSecret({
      db: fixture.db,
      organisationId: fixture.alpha.organisationId,
      handle: fixture.alpha.discordHandle,
      now: NOW + 2,
    });
    expectDenied(
      await resolveDiscordInteractionVerificationCredential({
        db: fixture.db,
        keys: fixture.keys,
        install: discordInstall(fixture, "123456789012345678"),
      }),
      "vault_secret_revoked",
    );
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }

  const signatures = probeSignatures();
  for (const line of captured) {
    assertCarriesNoCanary(line, signatures);
  }
}

async function durableRowProbe(): Promise<void> {
  const fixture = await createFixture();
  const signatures = probeSignatures();

  await expect(
    resolveProviderManifestCredential(manifestRequest(fixture, fixture.alpha)),
  ).resolves.toEqual({
    ok: true,
    value: { kind: "bearer", value: CANARY_ALPHA },
  });
  const betaContext = await activeProviderContext(
    fixture.db,
    fixture.beta.organisationId,
    fixture.beta.stripe,
  );
  await expect(
    resolveActiveProviderConnectionCredential({
      db: fixture.db,
      keys: fixture.keys,
      context: betaContext,
      expectedProvider: "stripe",
    }),
  ).resolves.toEqual({
    ok: true,
    value: { kind: "bearer", value: CANARY_BETA },
  });

  const cells = scanUserTableText(fixture.sqlite);
  expect(cells.length).toBeGreaterThan(0);
  const offenders = cells
    .filter((cell) =>
      signatures.some((signature) => cell.value.includes(signature)),
    )
    .map((cell) => `${cell.table}.${cell.column}`);
  expect(offenders).toEqual([]);

  const ciphertextCells = cells.filter(
    (cell) => cell.table === "vault_secret" && cell.column === "ciphertext_b64",
  );
  expect(ciphertextCells.length).toBeGreaterThanOrEqual(6);
  const alphaPayloadB64 = bearerPayloadB64(CANARY_ALPHA);
  const betaPayloadB64 = bearerPayloadB64(CANARY_BETA);
  for (const cell of ciphertextCells) {
    expect(cell.value).not.toBe(alphaPayloadB64);
    expect(cell.value).not.toBe(betaPayloadB64);
    expect(cell.value).not.toContain(alphaPayloadB64);
    expect(cell.value).not.toContain(betaPayloadB64);
  }

  for (const value of Object.values(process.env)) {
    if (typeof value === "string") {
      assertCarriesNoCanary(value, signatures);
    }
  }
}

async function errorPathProbe(): Promise<void> {
  const fixture = await createFixture();
  const signatures = probeSignatures();
  const handle = fixture.alpha.stripe.credentialRef;
  const original = await readCanaryRow(fixture, fixture.alpha.organisationId, handle);

  await corruptCiphertext(fixture.db, fixture.alpha.organisationId, handle);

  const denied = await resolveProviderManifestCredential(
    manifestRequest(fixture, fixture.alpha),
  );
  expect(denied).toEqual({
    ok: false,
    error: { code: "vault_ciphertext_invalid", handle },
  });

  const context = await activeProviderContext(
    fixture.db,
    fixture.alpha.organisationId,
    fixture.alpha.stripe,
  );
  const deniedConnection = await resolveActiveProviderConnectionCredential({
    db: fixture.db,
    keys: fixture.keys,
    context,
    expectedProvider: "stripe",
  });
  expect(deniedConnection).toEqual({
    ok: false,
    error: { code: "vault_ciphertext_invalid", handle },
  });

  for (const serialized of [
    JSON.stringify(denied),
    JSON.stringify(deniedConnection),
  ]) {
    assertCarriesNoCanary(serialized, signatures);
    expect(serialized).not.toContain(original.ciphertextB64);
    expect(serialized).not.toContain(original.ciphertextB64.slice(0, 24));
    expect(serialized).not.toContain(original.ciphertextB64.slice(-24));
    expect(serialized).not.toContain(CORRUPTED_CIPHERTEXT_B64);
  }
}

async function concurrentIsolationProbe(): Promise<void> {
  const fixture = await createFixture();
  const alphaContext = await activeProviderContext(
    fixture.db,
    fixture.alpha.organisationId,
    fixture.alpha.stripe,
  );
  const betaContext = await activeProviderContext(
    fixture.db,
    fixture.beta.organisationId,
    fixture.beta.stripe,
  );

  const tasks: ConcurrentProbeTask[] = [];
  for (let index = 0; index < CONCURRENT_PROBE_COUNT; index += 1) {
    tasks.push(concurrentProbeTask(fixture, alphaContext, betaContext, index));
  }
  const settled = await Promise.all(
    tasks.map(async (task) => ({ task, outcome: await task.outcome })),
  );

  let grantedCount = 0;
  let deniedCount = 0;
  for (const { task, outcome } of settled) {
    const serialized = JSON.stringify(outcome);
    if (task.expectation.kind === "granted") {
      grantedCount += 1;
      expect(outcome).toEqual({
        ok: true,
        value: { kind: "bearer", value: task.expectation.canary },
      });
      assertCarriesNoCanary(
        serialized,
        canarySignatures(task.expectation.foreignCanary),
      );
    } else {
      deniedCount += 1;
      expectDenied(outcome, task.expectation.code);
      assertCarriesNoCanary(serialized, probeSignatures());
    }
  }
  expect(grantedCount).toBe(CONCURRENT_PROBE_COUNT / 2);
  expect(deniedCount).toBe(CONCURRENT_PROBE_COUNT / 2);
}

type ProbeOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string } };

type ConcurrentProbeTask = {
  readonly expectation:
    | {
        readonly kind: "granted";
        readonly canary: string;
        readonly foreignCanary: string;
      }
    | { readonly kind: "denied"; readonly code: string };
  readonly outcome: Promise<ProbeOutcome>;
};

function concurrentProbeTask(
  fixture: CanaryProbeFixture,
  alphaContext: ActiveProviderAccountContext,
  betaContext: ActiveProviderAccountContext,
  index: number,
): ConcurrentProbeTask {
  switch (index % 8) {
    case 0:
      return {
        expectation: {
          kind: "granted",
          canary: CANARY_ALPHA,
          foreignCanary: CANARY_BETA,
        },
        outcome: resolveProviderManifestCredential(
          manifestRequest(fixture, fixture.alpha),
        ),
      };
    case 1:
      return {
        expectation: {
          kind: "granted",
          canary: CANARY_BETA,
          foreignCanary: CANARY_ALPHA,
        },
        outcome: resolveProviderManifestCredential(
          manifestRequest(fixture, fixture.beta),
        ),
      };
    case 2:
      return {
        expectation: {
          kind: "denied",
          code: "provider_manifest_scope_inactive",
        },
        outcome: resolveProviderManifestCredential({
          ...manifestRequest(fixture, fixture.alpha),
          credentialRef: fixture.beta.stripe.credentialRef,
        }),
      };
    case 3:
      return {
        expectation: {
          kind: "denied",
          code: "provider_manifest_scope_inactive",
        },
        outcome: resolveProviderManifestCredential({
          ...manifestRequest(fixture, fixture.beta),
          credentialRef: fixture.alpha.stripe.credentialRef,
        }),
      };
    case 4:
      return {
        expectation: {
          kind: "granted",
          canary: CANARY_ALPHA,
          foreignCanary: CANARY_BETA,
        },
        outcome: resolveActiveProviderConnectionCredential({
          db: fixture.db,
          keys: fixture.keys,
          context: alphaContext,
          expectedProvider: "stripe",
        }),
      };
    case 5:
      return {
        expectation: {
          kind: "granted",
          canary: CANARY_BETA,
          foreignCanary: CANARY_ALPHA,
        },
        outcome: resolveActiveProviderConnectionCredential({
          db: fixture.db,
          keys: fixture.keys,
          context: betaContext,
          expectedProvider: "stripe",
        }),
      };
    case 6:
      return {
        expectation: { kind: "denied", code: "webhook_binding_inactive" },
        outcome: resolveProviderWebhookCredential({
          db: fixture.db,
          keys: fixture.keys,
          organisationId: fixture.alpha.organisationId,
          provider: "stripe",
          context: providerWebhookContext(fixture, "acct_canary_forged"),
        }),
      };
    default:
      return {
        expectation: {
          kind: "denied",
          code: "provider_manifest_scope_inactive",
        },
        outcome: resolveProviderManifestCredential({
          ...manifestRequest(fixture, fixture.beta),
          environment: "production",
        }),
      };
  }
}

type ProviderScope = {
  readonly integrationAccountId: IntegrationAccountId;
  readonly providerConnectionId: ProviderConnectionId;
  readonly providerAccountId: string;
  readonly credentialRef: VaultHandle;
};

type CanaryOrganisation = {
  readonly organisationId: OrganisationId;
  readonly stripe: ProviderScope;
};

type CanaryOrganisationAlpha = CanaryOrganisation & {
  readonly slack: ProviderScope;
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  readonly webhookHandle: VaultHandle;
  readonly discordHandle: VaultHandle;
  readonly unrelatedHandle: VaultHandle;
};

type CanaryProbeFixture = {
  readonly db: SingleDatabase;
  readonly sqlite: DatabaseSync;
  readonly keys: CredentialVaultBindings;
  readonly alpha: CanaryOrganisationAlpha;
  readonly beta: CanaryOrganisation;
  readonly receipts: readonly VaultStoredSecret[];
};

async function createFixture(): Promise<CanaryProbeFixture> {
  const { sqlite, db } = createDatabase();
  const keys: CredentialVaultBindings = {
    PANTRY_VAULT_ACTIVE_KEY_VERSION: "v1",
    VAULT_ROOT_V1: testRoot(29),
  };
  const alphaOrganisationId = requireOk(parseOrganisationId("organisation_canary_alpha"));
  const betaOrganisationId = requireOk(parseOrganisationId("organisation_canary_beta"));
  await insertOrganisationBoundary(
    db,
    alphaOrganisationId,
    "user_c5d9d593-9171-506e-868e-d25ffec24324",
    "Canary Alpha",
  );
  await insertOrganisationBoundary(
    db,
    betaOrganisationId,
    "user_e0d213e1-8b5c-524f-b948-32c422db6bc6",
    "Canary Beta",
  );

  const alphaStripe = await insertProviderScope(
    db,
    keys,
    alphaOrganisationId,
    "user_c5d9d593-9171-506e-868e-d25ffec24324",
    "stripe",
    "alpha",
    CANARY_ALPHA,
  );
  const alphaSlack = await insertProviderScope(
    db,
    keys,
    alphaOrganisationId,
    "user_c5d9d593-9171-506e-868e-d25ffec24324",
    "slack",
    "alpha",
    CANARY_ALPHA,
  );
  const betaStripe = await insertProviderScope(
    db,
    keys,
    betaOrganisationId,
    "user_e0d213e1-8b5c-524f-b948-32c422db6bc6",
    "stripe",
    "beta",
    CANARY_BETA,
  );

  const webhookHandle = requireOk(
    parseVaultHandle("vault:test:canary:alpha:webhook"),
  );
  const discordHandle = requireOk(
    parseVaultHandle("vault:test:canary:alpha:discord"),
  );
  const unrelatedHandle = requireOk(
    parseVaultHandle("vault:test:canary:alpha:unrelated"),
  );
  const webhookReceipt = await storeProbeSecret(
    db,
    keys,
    alphaOrganisationId,
    webhookHandle,
    CANARY_ALPHA,
  );
  const discordReceipt = await storeProbeSecret(
    db,
    keys,
    alphaOrganisationId,
    discordHandle,
    CANARY_ALPHA,
  );
  const unrelatedReceipt = await storeProbeSecret(
    db,
    keys,
    alphaOrganisationId,
    unrelatedHandle,
    "unrelated-secret-alpha",
  );

  const alpha: CanaryOrganisationAlpha = {
    organisationId: alphaOrganisationId,
    stripe: alphaStripe.scope,
    slack: alphaSlack.scope,
    workspaceId: requireOk(parseWorkspaceId("workspace_canary_alpha")),
    sessionId: requireOk(parseSessionId("session_canary_probe")),
    webhookHandle,
    discordHandle,
    unrelatedHandle,
  };
  await insertProviderWebhook(db, alpha);
  await insertDiscordInstall(db, alpha);
  await insertAccountCleanup(db, alpha);
  await insertSurfaceInstallation(db, alpha);

  return {
    db,
    sqlite,
    keys,
    alpha,
    beta: { organisationId: betaOrganisationId, stripe: betaStripe.scope },
    receipts: [
      alphaStripe.receipt,
      alphaSlack.receipt,
      betaStripe.receipt,
      webhookReceipt,
      discordReceipt,
      unrelatedReceipt,
    ],
  };
}

async function insertOrganisationBoundary(
  db: SingleDatabase,
  organisationId: OrganisationId,
  userId: string,
  name: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
       VALUES (?, ?, 'beta', ?, 'active')`,
    )
    .bind(organisationId, name, NOW)
    .run();
  await db
    .prepare(
      `INSERT INTO app_user (
         user_id, issuer, subject, email, display_name,
         email_verified, created_at, last_authenticated_at
       ) VALUES (?, 'urn:test', ?, ?, ?, 1, ?, ?)`,
    )
    .bind(
      userId,
      userId,
      `${userId}@example.com`,
      name,
      NOW,
      NOW,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO organisation_onboarding (
         organisation_id, environment, lifecycle, capability_profile,
         configuration_version, projection_revision, activation_attempt_id,
         readiness_version, activation_receipt_id, activated_at,
         suspension_reason_code, suspended_at, archived_at, purge_after, updated_at
       ) VALUES (
         ?, 'development', 'active', 'approved_provider_writes',
         1, 1, NULL, NULL, ?, ?,
         NULL, NULL, NULL, NULL, ?
       )`,
    )
    .bind(organisationId, `activation_${userId}`, NOW, NOW)
    .run();
}

async function insertProviderScope(
  db: SingleDatabase,
  keys: CredentialVaultBindings,
  organisationId: OrganisationId,
  userId: string,
  provider: IntegrationProvider,
  suffix: string,
  secretValue: string,
): Promise<{
  readonly scope: ProviderScope;
  readonly receipt: VaultStoredSecret;
}> {
  const providerConnectionId = requireOk(
    parseProviderConnectionId(`connection_canary_${suffix}_${provider}`),
  );
  const integrationAccountId = requireOk(
    parseIntegrationAccountId(`account_canary_${suffix}_${provider}`),
  );
  const providerAccountId = `provider_account_canary_${suffix}_${provider}`;
  const credentialRef = requireOk(
    parseVaultHandle(`vault:test:canary:${suffix}:${provider}`),
  );
  const receipt = await storeProbeSecret(
    db,
    keys,
    organisationId,
    credentialRef,
    secretValue,
  );
  await db
    .prepare(
      `INSERT INTO provider_connection (
         provider_connection_id, organisation_id, provider, auth_mode, authority_kind,
         credential_generation, credential_ref, lifecycle, granted_scopes,
         created_by_user_id, created_at, updated_at,
         disabled_at, revoked_at, environment, provider_subject_id
       ) VALUES (
         ?, ?, ?, 'api_key', 'connection_credential', 1, ?, 'active', '["read_write"]',
         ?, ?, ?, NULL, NULL, 'development', ?
       )`,
    )
    .bind(
      providerConnectionId,
      organisationId,
      provider,
      credentialRef,
      userId,
      NOW,
      NOW,
      providerAccountId,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO integration_account (
         integration_account_id, organisation_id, provider_connection_id, provider,
         provider_account_id, account_kind, display_name, lifecycle,
         lifecycle_reason_code, capability_set, audience_policy, retention_policy,
         created_at, updated_at, disabled_by_user_id, disabled_at,
         revoked_at, environment, is_default_for_provider
       ) VALUES (
         ?, ?, ?, ?, ?, 'commerce', ?, 'active', NULL, '["read"]',
         '{"kind":"operator"}', '{"kind":"organisation_default"}', ?, ?,
         NULL, NULL, NULL, 'development', 1
       )`,
    )
    .bind(
      integrationAccountId,
      organisationId,
      providerConnectionId,
      provider,
      providerAccountId,
      `${provider} canary ${suffix} account`,
      NOW,
      NOW,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO provider_credential_generation (
         provider_connection_id, credential_generation, organisation_id, provider,
         environment, credential_ref, lifecycle, created_at, activated_at,
         superseded_at, revoked_at, failed_at, failure_code
       ) VALUES (?, 1, ?, ?, 'development', ?, 'active', ?, ?, NULL, NULL, NULL, NULL)`,
    )
    .bind(providerConnectionId, organisationId, provider, credentialRef, NOW, NOW)
    .run();

  return {
    scope: {
      integrationAccountId,
      providerConnectionId,
      providerAccountId,
      credentialRef,
    },
    receipt,
  };
}

async function insertProviderWebhook(
  db: SingleDatabase,
  alpha: CanaryOrganisationAlpha,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO provider_webhook (
         provider_webhook_id, organisation_id, integration_account_id, provider,
         provider_native_id, event_type, lifecycle, lifecycle_reason_code,
         signing_secret_ref, credential_generation, last_verified_at, updated_at,
         environment
       ) VALUES ('webhook_canary_alpha', ?, ?, 'stripe', 'endpoint_canary',
         'payment_intent.succeeded', 'live', NULL, ?, 1, ?, ?, 'development')`,
    )
    .bind(
      alpha.organisationId,
      alpha.stripe.integrationAccountId,
      alpha.webhookHandle,
      NOW,
      NOW,
    )
    .run();
}

async function insertDiscordInstall(
  db: SingleDatabase,
  alpha: CanaryOrganisationAlpha,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO discord_interaction_install (
         organisation_id, application_id, guild_id, public_key_ref, status, installed_at
       ) VALUES (?, '111111111111111111', '123456789012345678', ?, 'active', ?)`,
    )
    .bind(alpha.organisationId, alpha.discordHandle, NOW)
    .run();
}

async function insertAccountCleanup(
  db: SingleDatabase,
  alpha: CanaryOrganisationAlpha,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO provider_account_cleanup (
         cleanup_id, organisation_id, integration_account_id, provider, environment,
         lifecycle, reason_code, instruction_code, attempt, next_attempt_at,
         created_at, updated_at, completed_at,
         provider_account_id, provider_connection_id, credential_handles,
         provider_webhook_ids, provider_context
       ) VALUES ('cleanup_canary_alpha', ?, ?, 'stripe', 'development',
         'pending_provider_cleanup', NULL, NULL, 0, ?, ?, ?, NULL, ?, ?, ?, '[]',
         '{"provider":"stripe"}')`,
    )
    .bind(
      alpha.organisationId,
      alpha.stripe.integrationAccountId,
      NOW,
      NOW,
      NOW,
      alpha.stripe.providerAccountId,
      alpha.stripe.providerConnectionId,
      JSON.stringify([alpha.unrelatedHandle]),
    )
    .run();
}

async function insertSurfaceInstallation(
  db: SingleDatabase,
  alpha: CanaryOrganisationAlpha,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO surface_installation (
         integration_account_id, organisation_id, surface_kind, workspace_id,
         install_model, bot_token_ref, scopes, installed_at, last_event_received_at
       ) VALUES (?, ?, 'slack', ?, 'custom', ?, '["chat:write"]', ?, NULL)`,
    )
    .bind(
      alpha.slack.integrationAccountId,
      alpha.organisationId,
      alpha.workspaceId,
      alpha.slack.credentialRef,
      NOW,
    )
    .run();
}

async function storeProbeSecret(
  db: SingleDatabase,
  keys: CredentialVaultBindings,
  organisationId: OrganisationId,
  handle: VaultHandle,
  value: string,
): Promise<VaultStoredSecret> {
  const stored = await storeVaultSecret({
    db,
    keys,
    organisationId,
    handle,
    secret: { kind: "bearer", value },
    now: NOW,
  });
  if (!stored.ok) {
    throw new Error(stored.error.code);
  }
  return stored.value;
}

async function setStripeGenerationLifecycle(
  fixture: CanaryProbeFixture,
  lifecycle: "active" | "superseded",
): Promise<void> {
  const supersededAt = lifecycle === "superseded" ? NOW + 1 : null;
  await fixture.db
    .prepare(
      `UPDATE provider_credential_generation
       SET lifecycle = ?, superseded_at = ?
       WHERE provider_connection_id = ? AND credential_generation = 1`,
    )
    .bind(lifecycle, supersededAt, fixture.alpha.stripe.providerConnectionId)
    .run();
}

async function corruptCiphertext(
  db: SingleDatabase,
  organisationId: OrganisationId,
  handle: VaultHandle,
): Promise<void> {
  await db
    .prepare(
      `UPDATE vault_secret
       SET ciphertext_b64 = ?
       WHERE organisation_id = ? AND vault_handle = ?`,
    )
    .bind(CORRUPTED_CIPHERTEXT_B64, organisationId, handle)
    .run();
}

async function readCanaryRow(
  fixture: CanaryProbeFixture,
  organisationId: OrganisationId,
  handle: VaultHandle,
): Promise<{ readonly ciphertextB64: string }> {
  const row = await fixture.db
    .prepare(
      `SELECT ciphertext_b64 AS ciphertextB64
       FROM vault_secret
       WHERE organisation_id = ? AND vault_handle = ?`,
    )
    .bind(organisationId, handle)
    .first<{ readonly ciphertextB64: string }>();
  if (row === null) {
    throw new Error("canary vault row missing");
  }
  return row;
}

async function readVaultCiphertexts(
  db: SingleDatabase,
): Promise<readonly string[]> {
  const rows = await db
    .prepare(
      `SELECT nonce_b64 AS nonceB64, ciphertext_b64 AS ciphertextB64
       FROM vault_secret`,
    )
    .all<{ readonly nonceB64: string; readonly ciphertextB64: string }>();
  return (rows.results ?? []).flatMap((row) => [
    row.nonceB64,
    row.ciphertextB64,
  ]);
}

async function activeProviderContext(
  db: SingleDatabase,
  organisationId: OrganisationId,
  scope: ProviderScope,
): Promise<ActiveProviderAccountContext> {
  const context = await resolveActiveProviderAccountContext({
    db,
    organisationId,
    integrationAccountId: scope.integrationAccountId,
  });
  if (!context.ok) {
    throw new Error(context.error.code);
  }
  return context.value;
}

function manifestRequest(
  fixture: CanaryProbeFixture,
  organisation: CanaryOrganisation,
): Parameters<typeof resolveProviderManifestCredential>[0] {
  return {
    db: fixture.db,
    keys: fixture.keys,
    organisationId: organisation.organisationId,
    integrationAccountId: organisation.stripe.integrationAccountId,
    provider: "stripe",
    environment: "development",
    providerAccountId: organisation.stripe.providerAccountId,
    credentialRef: organisation.stripe.credentialRef,
  };
}

function providerWebhookContext(
  fixture: CanaryProbeFixture,
  providerAccountId: string,
): LiveProviderWebhookContext {
  return {
    integrationAccountId: fixture.alpha.stripe.integrationAccountId,
    providerAccountId,
    environment: "development",
    signingSecretRef: fixture.alpha.webhookHandle,
    credentialGeneration: 1,
  };
}

function discordInstall(
  fixture: CanaryProbeFixture,
  guildIdRaw: string,
): DiscordInteractionInstall {
  return {
    organisationId: fixture.alpha.organisationId,
    applicationId: requireOk(parseDiscordApplicationId("111111111111111111")),
    guildId: requireOk(parseDiscordGuildId(guildIdRaw)),
    publicKeyRef: fixture.alpha.discordHandle,
    status: "active",
  };
}

function surfaceInstall(
  fixture: CanaryProbeFixture,
  workspaceId: WorkspaceId,
): OrganisationInstallRecord {
  return {
    integrationAccountId: fixture.alpha.slack.integrationAccountId,
    organisationId: fixture.alpha.organisationId,
    name: "Canary Alpha",
    plan: "beta",
    organisationStatus: "active",
    surfaceKind: "slack",
    workspaceId,
    installModel: "custom",
    botTokenRef: fixture.alpha.slack.credentialRef,
    scopes: ["chat:write"],
    installedAt: NOW,
    installStatus: "active",
    lastEventReceivedAt: null,
    placement: requirePlacement(),
  };
}

function signedAction(
  organisationId: OrganisationId,
  integrationAccountId: IntegrationAccountId,
  sessionId: SessionId,
): AuthorizedProviderAction {
  const authority = fixtureProviderActionAuthority({
    organisationId,
    integrationAccountId,
    providerResourceScope: "stripe:charge.create",
  });
  return {
    caseId: requireOk(parseCaseId("case_canary_probe")),
    proposalId: "proposal_canary_probe",
    commerceEffect: null,
    state: "executing",
    action: {
      organisationId,
      integrationAccountId,
      requestAuthority: authority.requestAuthority,
      authorityPartition: authority.authorityPartition,
      authority: { kind: "integration_account" },
      sessionId,
      threadId: "slack:T:C:canary-probe",
      host: "api.stripe.com",
      verb: "stripe.charge.create",
      path: "/v1/charges",
      argsHash: "canary-probe-args",
      amount: { value: 100, currency: "USD" },
      nonce: { value: "canary-probe-nonce" },
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
      leaseId: "lease_canary_probe",
      expiresAt: NOW + 30_000,
    },
    idempotencyKey: "canary-probe-idempotency",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function approvalEvidence(): ApprovalEvidence {
  const actionDigest = parseApprovalProofDigest("00".repeat(32));
  if (actionDigest === null) {
    throw new Error("invalid approval fixture digest");
  }
  return {
    kind: "app_user",
    principal: {
      kind: "app_user",
      userId: requireOk(
        parseUserId("user_25b6d43e-e6fe-596e-bdb6-861cfd2cad85"),
      ),
      personId: requireOk(parsePersonId("person_canary_probe")),
      role: "owner",
    },
    authentication: {
      kind: "google_oidc_step_up",
      controlSessionId: requireOk(
        parseControlSessionId("control_session_canary_probe"),
      ),
      authenticatedAt: NOW,
      challenge: {
        stepUpId: "fixture:canary_probe",
        organisationId: requireOk(parseOrganisationId("organisation_canary_alpha")),
        actionNonce: "action_canary_probe",
        actionDigest,
        policy: { kind: "unversioned_default" },
        issuedAt: NOW,
        expiresAt: NOW + 600_000,
      },
    },
  };
}

function requirePlacement(): OrganisationInstallRecord["placement"] {
  return requireOk(
    parseOrganisationPlacement({
      kind: "affinity",
      placementEpoch: 1,
      placementCellId: "test-cell",
      locationHint: "wnam",
    }),
  );
}

function expectDenied(outcome: ProbeOutcome, code: string): string {
  if (outcome.ok) {
    throw new Error(`expected denial ${code} but resolution succeeded`);
  }
  expect(outcome.error.code).toBe(code);
  return JSON.stringify(outcome);
}

function probeSignatures(): readonly string[] {
  return [...canarySignatures(CANARY_ALPHA), ...canarySignatures(CANARY_BETA)];
}

function canarySignatures(value: string): readonly string[] {
  return [
    value,
    trimBase64Boundary(btoa(value)),
    trimBase64Boundary(btoa(`.${value}`)),
    trimBase64Boundary(btoa(`..${value}`)),
  ];
}

function trimBase64Boundary(encoded: string): string {
  return encoded.slice(4, -4);
}

function assertCarriesNoCanary(
  serialized: string,
  signatures: readonly string[],
): void {
  for (const signature of signatures) {
    expect(serialized).not.toContain(signature);
  }
}

function bearerPayloadB64(value: string): string {
  return btoa(JSON.stringify({ kind: "bearer", value, header: null }));
}

function requireReceipt(
  fixture: CanaryProbeFixture,
  handle: VaultHandle,
): VaultStoredSecret {
  const receipt = fixture.receipts.find(
    (candidate) => candidate.handle === handle,
  );
  if (receipt === undefined) {
    throw new Error("vault receipt missing");
  }
  return receipt;
}

function requireOk<TValue>(
  parsed: Result<TValue, { readonly code: string }>,
): TValue {
  if (!parsed.ok) {
    throw new Error(parsed.error.code);
  }
  return parsed.value;
}

type ScannedCell = {
  readonly table: string;
  readonly column: string;
  readonly value: string;
};

function scanUserTableText(sqlite: DatabaseSync): readonly ScannedCell[] {
  const tables = sqlite
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as unknown as readonly { readonly name: string }[];
  const cells: ScannedCell[] = [];

  for (const table of tables) {
    const rows = sqlite
      .prepare(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`)
      .all() as readonly Record<string, unknown>[];

    for (const row of rows) {
      for (const [column, value] of Object.entries(row)) {
        if (typeof value === "string") {
          cells.push({ table: table.name, column, value });
        }
      }
    }
  }

  return cells;
}

function renderLogValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let hex = "";

  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }

  return hex;
}

function createDatabase(): {
  readonly sqlite: DatabaseSync;
  readonly db: SingleDatabase;
} {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(singleDatabaseSchema());

  return { sqlite, db: d1Database(sqlite) };
}
