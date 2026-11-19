import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
import { requireOrganisationBootstrap } from "./organisation-execution-fixture";
import { describe, expect, it } from "vitest";

import {
  hashOpaqueSecret,
  issueControlSession,
  upsertUser,
} from "../src/data/control-plane";
import {
  newControlMutationIdentity,
  readControlMutationReplay,
} from "../src/data/control-mutation";
import {
  createActiveConnectedIntegration,
  type ConnectedIntegrationSeed,
} from "../src/data/integration-account";
import type { UserId, IntegrationAccountId, OrganisationId } from "../src/ids";
import {
  cancelProviderAttempt,
  beginProviderProvisioning,
  consumeProviderAuthorizationState,
  createAuthorizingProviderAttempt,
  parseConnectionProvider,
  providerAttemptWire,
  readProviderAttempt,
  readResumableProviderAuthorization,
  type ConnectionProvider,
} from "../src/data/provider-attempt";
import {
  beginProviderOAuth,
  providerAuthorizationUrlForMutation,
  type ProviderOAuthStartEnv,
} from "../src/provider-lifecycle/authorization";
import { organisationBootstrapMutation } from "./control-mutation-fixture";
import { TEST_INITIAL_ORGANISATION_PLACEMENT } from "./fixtures/organisation-placement";
import { requireVaultHandle } from "./test-ids";
import { createMigratedDatabase } from "./sqlite-d1";

const NOW = 1_784_190_000_000;

describe("provider connection attempts", () => {
  it("round-trips every connection provider the union declares", () => {
    const declared: Readonly<Record<ConnectionProvider, true>> = {
      airtable: true,
      dropbox: true,
      gmail: true,
      google_drive: true,
      notion: true,
      shopify: true,
      slack: true,
      square: true,
      stripe: true,
      whatsapp: true,
    };
    for (const provider of Object.keys(declared) as ConnectionProvider[]) {
      expect(parseConnectionProvider(provider), provider).toBe(provider);
    }
    expect(parseConnectionProvider("discord")).toBeNull();
  });

  it("binds and consumes callback state once, then preserves one immutable terminal attempt", async () => {
    const db = createMigratedDatabase();
    const owner = await upsertUser({
      db,
      identity: {
        issuer: "https://accounts.google.com",
        subject: "provider-owner",
        email: "provider@example.com",
        displayName: "Provider Owner",
        emailVerified: true,
      },
      now: NOW,
    });
    const organisation = await requireOrganisationBootstrap({
      env: {
        DB: db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      owner,
      organisationName: "Provider Merchant",
      environment: "development",
      mutation: organisationBootstrapMutation(owner, NOW),
      placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
      now: NOW,
    });
    const state = "unguessable-provider-state";
    const started = await createAuthorizingProviderAttempt({
      db,
      organisationId: organisation.organisationId,
      provider: "slack",
      userId: owner.userId,
      existingIntegrationAccountId: null,
      purpose: "connect",
      portalSubjectHash: "provider-subject-hash",
      stateHash: await hashOpaqueSecret(state),
      nonceHash: await hashOpaqueSecret("provider-nonce"),
      pkceVerifier: null,
      providerContext: JSON.stringify({ provider: "slack" }),
      returnPath: `/portal/${organisation.organisationId}`,
      expiresAt: NOW + 600_000,
      mutation: providerMutation(
        owner.userId,
        organisation.organisationId,
        "start-key-0001",
        NOW + 1,
      ),
      now: NOW + 1,
    });
    if (!started.ok) {
      throw new Error(`provider attempt start failed: ${started.error.code}`);
    }
    expect(providerAttemptWire(started.value.attempt)).toMatchObject({
      organisation_id: organisation.organisationId,
      provider: "slack",
      environment: "development",
      state: { kind: "authorizing" },
    });
    const receipt = await db
      .prepare(
        `SELECT response_body AS responseBody
       FROM control_mutation_receipt WHERE receipt_id = ?`,
      )
      .bind(started.value.receiptId)
      .first<{ readonly responseBody: unknown }>();
    expect(receipt?.responseBody).toEqual(expect.any(String));
    expect(receipt?.responseBody).not.toContain(state);
    expect(receipt?.responseBody).not.toContain("authorization_url");

    await expect(
      consumeProviderAuthorizationState({
        scope: await requireOrganisationExecutionScope(
          {
            DB: db,
            PANTRY_ORGANISATION_PLACEMENT_PROFILE:
              TEST_ORGANISATION_PLACEMENT_PROFILE,
          },
          organisation.organisationId,
        ),
        provider: "stripe",
        stateHash: await hashOpaqueSecret(state),
        callbackCodeHash: await hashOpaqueSecret("oauth-code"),
        now: NOW + 2,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "provider_state_invalid" },
    });

    const consumed = await consumeProviderAuthorizationState({
      scope: await requireOrganisationExecutionScope(
        {
          DB: db,
          PANTRY_ORGANISATION_PLACEMENT_PROFILE:
            TEST_ORGANISATION_PLACEMENT_PROFILE,
        },
        organisation.organisationId,
      ),
      provider: "slack",
      stateHash: await hashOpaqueSecret(state),
      callbackCodeHash: await hashOpaqueSecret("oauth-code"),
      now: NOW + 2,
    });
    expect(consumed).toMatchObject({
      ok: true,
      value: {
        kind: "consumed",
        value: { attempt: { kind: "callback_received" } },
      },
    });

    const replayed = await consumeProviderAuthorizationState({
      scope: await requireOrganisationExecutionScope(
        {
          DB: db,
          PANTRY_ORGANISATION_PLACEMENT_PROFILE:
            TEST_ORGANISATION_PLACEMENT_PROFILE,
        },
        organisation.organisationId,
      ),
      provider: "slack",
      stateHash: await hashOpaqueSecret(state),
      callbackCodeHash: await hashOpaqueSecret("oauth-code"),
      now: NOW + 3,
    });
    expect(replayed).toMatchObject({
      ok: true,
      value: { kind: "replayed", attempt: { kind: "callback_received" } },
    });
    await expect(
      consumeProviderAuthorizationState({
        scope: await requireOrganisationExecutionScope(
          {
            DB: db,
            PANTRY_ORGANISATION_PLACEMENT_PROFILE:
              TEST_ORGANISATION_PLACEMENT_PROFILE,
          },
          organisation.organisationId,
        ),
        provider: "slack",
        stateHash: await hashOpaqueSecret(state),
        callbackCodeHash: await hashOpaqueSecret("different-code"),
        now: NOW + 3,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "provider_state_replayed" },
    });

    const cancelled = await cancelProviderAttempt({
      db,
      organisationId: organisation.organisationId,
      attemptId: started.value.attempt.attemptId,
      actorUserId: owner.userId,
      reasonCode: "authorization_cancelled",
      mutation: providerMutation(
        owner.userId,
        organisation.organisationId,
        "cancel-key-0001",
        NOW + 4,
      ),
      now: NOW + 4,
    });
    expect(cancelled).toMatchObject({
      ok: true,
      value: { attempt: { kind: "cancelled" } },
    });
    const secondCancel = await cancelProviderAttempt({
      db,
      organisationId: organisation.organisationId,
      attemptId: started.value.attempt.attemptId,
      actorUserId: owner.userId,
      reasonCode: "authorization_cancelled",
      mutation: providerMutation(
        owner.userId,
        organisation.organisationId,
        "cancel-key-0002",
        NOW + 5,
      ),
      now: NOW + 5,
    });
    expect(secondCancel).toEqual({
      ok: false,
      error: { code: "provider_attempt_terminal" },
    });
    await expect(
      consumeProviderAuthorizationState({
        scope: await requireOrganisationExecutionScope(
          {
            DB: db,
            PANTRY_ORGANISATION_PLACEMENT_PROFILE:
              TEST_ORGANISATION_PLACEMENT_PROFILE,
          },
          organisation.organisationId,
        ),
        provider: "slack",
        stateHash: await hashOpaqueSecret(state),
        callbackCodeHash: await hashOpaqueSecret("oauth-code"),
        now: NOW + 5,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { kind: "replayed", attempt: { kind: "cancelled" } },
    });
    const authorizationState = await db
      .prepare(
        `SELECT invalidated_at AS invalidatedAt,
              invalidation_reason AS invalidationReason
       FROM provider_authorization_state WHERE attempt_id = ?`,
      )
      .bind(started.value.attempt.attemptId)
      .first<{
        readonly invalidatedAt: unknown;
        readonly invalidationReason: unknown;
      }>();
    expect(authorizationState).toEqual({
      invalidatedAt: NOW + 4,
      invalidationReason: "cancelled",
    });
    const canonical = await readProviderAttempt({
      db,
      organisationId: organisation.organisationId,
      attemptId: started.value.attempt.attemptId,
    });
    expect(canonical).toMatchObject({
      ok: true,
      value: {
        kind: "cancelled",
        cancelledByUserId: owner.userId,
        completedAt: NOW + 4,
      },
    });
  });
  it(
    "reconnects beside an unrelated connect attempt and preserves its mutation fence",
    resumeAuthorizationTest,
  );
});

async function resumeAuthorizationTest(): Promise<void> {
  const db = createMigratedDatabase();
  const owner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "provider-resume-owner",
      email: "provider-resume@example.com",
      displayName: "Provider Resume Owner",
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
    organisationName: "Provider Resume Merchant",
    environment: "development",
    mutation: organisationBootstrapMutation(owner, NOW),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: NOW,
  });
  const firstAccount = await createActiveConnectedIntegration(
    db,
    slackSeed(organisation.organisationId, owner.userId, "T-RESUME-ONE", NOW),
  );
  const secondAccount = await createActiveConnectedIntegration(
    db,
    slackSeed(
      organisation.organisationId,
      owner.userId,
      "T-RESUME-TWO",
      NOW + 1,
    ),
  );
  const otherOwner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "provider-resume-other-owner",
      email: "provider-resume-other@example.com",
      displayName: "Provider Resume Other Owner",
      emailVerified: true,
    },
    now: NOW,
  });
  const session = await issueControlSession({
    db,
    userId: owner.userId,
    now: NOW,
    ttlMs: 600_000,
  });
  const unrelatedConnect = await createAuthorizingProviderAttempt({
    db,
    organisationId: organisation.organisationId,
    provider: "slack",
    userId: owner.userId,
    existingIntegrationAccountId: null,
    purpose: "connect",
    portalSubjectHash: "provider-resume-subject-hash",
    stateHash: await hashOpaqueSecret("provider-unrelated-connect-state"),
    nonceHash: await hashOpaqueSecret("provider-unrelated-connect-nonce"),
    pkceVerifier: null,
    providerContext: JSON.stringify({ provider: "slack" }),
    returnPath: `/portal/${organisation.organisationId}`,
    expiresAt: NOW + 600_000,
    mutation: {
      boundary: {
        kind: "configuration_versioned",
        idempotencyKey: "unrelated-connect-key-0001",
        requestHash: "c".repeat(64),
        expectedConfigurationVersion: 3,
      },
      scope: {
        userId: owner.userId,
        organisationScope: organisation.organisationId,
        route: `/v1/control/organisations/${organisation.organisationId}/providers/slack/start`,
        operation: "provider.attempt.start",
      },
      identity: newControlMutationIdentity({
        portalSubjectHash: "provider-resume-subject-hash",
        causationId: "unrelated-connect-key-0001-request",
        now: NOW + 2,
      }),
    },
    now: NOW + 2,
  });
  expect(unrelatedConnect.ok).toBe(true);
  const firstMutation = reconnectMutation(
    owner.userId,
    organisation.organisationId,
    firstAccount.account.integrationAccountId,
    "resume-reconnect-key-0001",
    NOW + 3,
  );
  const secondMutation = reconnectMutation(
    owner.userId,
    organisation.organisationId,
    firstAccount.account.integrationAccountId,
    "resume-reconnect-key-0002",
    NOW + 4,
  );
  const env: ProviderOAuthStartEnv = {
    PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    DB: db,
    PANTRY_PUBLIC_ORIGIN: "https://pantry.example.test",
    SLACK_CLIENT_ID: "slack-client-id",
    SLACK_CLIENT_SECRET: "slack-client-secret",
  };
  const started = await beginProviderOAuth({
    env,
    session: session.session,
    organisationId: organisation.organisationId,
    context: { provider: "slack" },
    existingIntegrationAccountId: firstAccount.account.integrationAccountId,
    purpose: "reconnect",
    returnPath: `/portal/${organisation.organisationId}`,
    mutation: firstMutation,
    now: NOW + 3,
  });
  if (!started.ok) {
    throw new Error(`provider attempt start failed: ${started.error.code}`);
  }
  const resumed = await beginProviderOAuth({
    env,
    session: session.session,
    organisationId: organisation.organisationId,
    context: { provider: "slack" },
    existingIntegrationAccountId: firstAccount.account.integrationAccountId,
    purpose: "reconnect",
    returnPath: `/portal/${organisation.organisationId}`,
    mutation: secondMutation,
    now: NOW + 4,
  });
  if (!resumed.ok) {
    throw new Error(`provider attempt resume failed: ${resumed.error.code}`);
  }
  expect(resumed.value).toEqual(started.value);
  await expect(
    readControlMutationReplay({
      db,
      scope: firstMutation.scope,
      boundary: firstMutation.boundary,
    }),
  ).resolves.toMatchObject({ kind: "replay" });
  await expect(
    readControlMutationReplay({
      db,
      scope: secondMutation.scope,
      boundary: secondMutation.boundary,
    }),
  ).resolves.toEqual({ kind: "absent" });

  const airtableAuthorizationUrl = new URL(
    await providerAuthorizationUrlForMutation({
      env: {
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
        DB: db,
        PANTRY_OAUTH_CALLBACK_ORIGIN: "https://oauth.pantry.example.test",
        PANTRY_PUBLIC_ORIGIN: "https://pantry.example.test",
        AIRTABLE_OAUTH_CLIENT_ID: "airtable-client-id",
        AIRTABLE_OAUTH_CLIENT_SECRET: "airtable-client-secret",
      },
      context: { provider: "airtable" },
      mutation: firstMutation,
    }),
  );
  expect(airtableAuthorizationUrl.origin).toBe("https://airtable.com");
  expect(airtableAuthorizationUrl.pathname).toBe("/oauth2/v1/authorize");
  expect(airtableAuthorizationUrl.searchParams.get("redirect_uri")).toBe(
    "https://oauth.pantry.example.test/v1/control/providers/airtable/callback",
  );
  expect(airtableAuthorizationUrl.searchParams.get("scope")).toBe(
    "data.records:read data.records:write schema.bases:read schema.bases:write data.recordComments:read data.recordComments:write webhook:manage",
  );
  expect(
    airtableAuthorizationUrl.searchParams.get("code_challenge_method"),
  ).toBe("S256");
  expect(airtableAuthorizationUrl.searchParams.get("code_challenge")).toMatch(
    /^[A-Za-z0-9_-]{43}$/u,
  );

  const providerContext = JSON.stringify({ provider: "slack" });
  const storedAuthorization = await readResumableProviderAuthorization({
    db,
    organisationId: organisation.organisationId,
    provider: "slack",
    userId: owner.userId,
    existingIntegrationAccountId: firstAccount.account.integrationAccountId,
    purpose: "reconnect",
    providerContext,
  });
  expect(storedAuthorization).toMatchObject({
    attempt: {
      kind: "authorizing",
      attemptId: started.value.attempt.attempt_id,
    },
    receiptId: started.value.receiptId,
    mutation: {
      boundary: firstMutation.boundary,
      scope: firstMutation.scope,
    },
  });
  const mismatches = [
    {
      userId: otherOwner.userId,
      existingIntegrationAccountId: firstAccount.account.integrationAccountId,
      purpose: "reconnect" as const,
    },
    {
      userId: owner.userId,
      existingIntegrationAccountId: secondAccount.account.integrationAccountId,
      purpose: "reconnect" as const,
    },
    {
      userId: owner.userId,
      existingIntegrationAccountId: firstAccount.account.integrationAccountId,
      purpose: "rotate" as const,
    },
  ];
  for (const mismatch of mismatches) {
    await expect(
      readResumableProviderAuthorization({
        db,
        organisationId: organisation.organisationId,
        provider: "slack",
        userId: mismatch.userId,
        existingIntegrationAccountId: mismatch.existingIntegrationAccountId,
        purpose: mismatch.purpose,
        providerContext,
      }),
    ).resolves.toBeNull();
  }
  await expect(
    readResumableProviderAuthorization({
      db,
      organisationId: organisation.organisationId,
      provider: "slack",
      userId: owner.userId,
      existingIntegrationAccountId: firstAccount.account.integrationAccountId,
      purpose: "reconnect",
      providerContext: JSON.stringify({
        provider: "shopify",
        shopDomain: "other.myshopify.com",
      }),
    }),
  ).resolves.toBeNull();
  const state = new URL(started.value.authorizationUrl).searchParams.get(
    "state",
  );
  if (state === null) throw new Error("Missing state");
  const consumed = await consumeProviderAuthorizationState({
    scope: await requireOrganisationExecutionScope(
      {
        DB: db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      organisation.organisationId,
    ),
    provider: "slack",
    stateHash: await hashOpaqueSecret(state),
    callbackCodeHash: await hashOpaqueSecret("interrupted-code"),
    now: NOW + 5,
  });
  if (!consumed.ok || consumed.value.kind !== "consumed")
    throw new Error("Callback was not admitted");
  const provisioning = await beginProviderProvisioning({
    scope: await requireOrganisationExecutionScope(
      {
        DB: db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      organisation.organisationId,
    ),
    attempt: consumed.value.value.attempt,
    now: NOW + 6,
  });
  if (!provisioning.ok) throw new Error(provisioning.error.code);
  const retryAt = started.value.attempt.expires_at + 1;
  const retried = await beginProviderOAuth({
    env,
    session: session.session,
    organisationId: organisation.organisationId,
    context: { provider: "slack" },
    existingIntegrationAccountId: firstAccount.account.integrationAccountId,
    purpose: "reconnect",
    returnPath: `/portal/${organisation.organisationId}`,
    mutation: reconnectMutation(
      owner.userId,
      organisation.organisationId,
      firstAccount.account.integrationAccountId,
      "resume-after-interruption",
      retryAt,
    ),
    now: retryAt,
  });
  expect(retried).toMatchObject({
    ok: true,
    value: { attempt: { state: { kind: "authorizing" } } },
  });
  expect(
    await readProviderAttempt({
      db,
      organisationId: organisation.organisationId,
      attemptId: provisioning.value.attemptId,
    }),
  ).toMatchObject({ ok: true, value: { kind: "expired" } });
  expect(
    await db
      .prepare(
        "SELECT lifecycle, reason_code FROM provider_provisioning_attempt WHERE provisioning_attempt_id = ?",
      )
      .bind(provisioning.value.provisioningAttemptId)
      .first(),
  ).toMatchObject({
    lifecycle: "failed_retryable",
    reason_code: "authorization_expired",
  });
}

function reconnectMutation(
  userId: UserId,
  organisationId: OrganisationId,
  integrationAccountId: IntegrationAccountId,
  idempotencyKey: string,
  now: number,
) {
  return {
    boundary: {
      kind: "configuration_versioned" as const,
      idempotencyKey,
      requestHash: "b".repeat(64),
      expectedConfigurationVersion: 3,
    },
    scope: {
      userId,
      organisationScope: organisationId,
      route: `/v1/control/organisations/${organisationId}/accounts/${integrationAccountId}/reconnect`,
      operation: "provider.account.reconnect",
    },
    identity: newControlMutationIdentity({
      portalSubjectHash: "provider-resume-subject-hash",
      causationId: `${idempotencyKey}-request`,
      now,
    }),
  };
}

function slackSeed(
  organisationId: OrganisationId,
  userId: UserId,
  workspaceId: string,
  now: number,
): ConnectedIntegrationSeed {
  return {
    organisationId,
    provider: "slack",
    providerSubjectId: workspaceId,
    environment: "development",
    authMode: "shared_satyr_app",
    authority: {
      kind: "connection_credential",
      credentialRef: requireVaultHandle(
        `vault:organisation:slack:${workspaceId.toLowerCase()}:oauth:g1`,
      ),
    },
    grantedScopes: ["channels:read", "chat:write"],
    createdByUserId: userId,
    providerAccountId: workspaceId,
    accountKind: "workspace",
    displayName: workspaceId,
    capabilities: ["conversation.ingress", "conversation.egress"],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now,
  };
}

function providerMutation(
  userId: UserId,
  organisationId: OrganisationId,
  idempotencyKey: string,
  now: number,
) {
  return {
    boundary: {
      kind: "configuration_versioned" as const,
      idempotencyKey,
      requestHash: "a".repeat(64),
      expectedConfigurationVersion: 1,
    },
    scope: {
      userId,
      organisationScope: organisationId,
      route: `/v1/control/organisations/${organisationId}/provider-attempts`,
      operation: idempotencyKey.startsWith("start")
        ? "provider.attempt.start"
        : "provider.attempt.cancel",
    },
    identity: newControlMutationIdentity({
      portalSubjectHash: "provider-subject-hash",
      causationId: `${idempotencyKey}-request`,
      now,
    }),
  };
}
