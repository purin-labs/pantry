import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
import { requireOrganisationBootstrap } from "./organisation-execution-fixture";
import { describe, expect, it } from "vitest";

import { hashOpaqueSecret, upsertUser } from "../src/data/control-plane";
import { newControlMutationIdentity } from "../src/data/control-mutation";
import {
  createConnectedIntegration,
  finalizeConnectedIntegrationAccount,
  upsertSurfaceInstallation,
} from "../src/data/integration-account";
import { buildOnboardingProjection } from "../src/data/onboarding-projection";
import { createAuthorizingProviderAttempt } from "../src/data/provider-attempt";
import { persistProviderResourceSnapshot } from "../src/data/provider-resource";
import { parseVaultHandle } from "../src/credential-vault";
import { organisationBootstrapMutation } from "./control-mutation-fixture";
import { TEST_INITIAL_ORGANISATION_PLACEMENT } from "./fixtures/organisation-placement";
import { createMigratedDatabase } from "./sqlite-d1";

const NOW = 1_784_093_296_426;

describe("merchant onboarding projection", () => {
  it("renders a fresh organisation from one canonical versioned projection", async () => {
    const db = createMigratedDatabase();
    const owner = await upsertUser({
      db,
      identity: {
        issuer: "https://accounts.google.com",
        subject: "projection-owner",
        email: "projection@example.com",
        displayName: "Projection Owner",
        emailVerified: true,
      },
      now: NOW,
    });
    const organisation = await requireOrganisationBootstrap({
      env: {
        DB: db,
        SATYR_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      owner,
      organisationName: "Projection Commerce",
      environment: "development",
      mutation: organisationBootstrapMutation(owner, NOW),
      placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
      now: NOW,
    });

    await expect(
      buildOnboardingProjection({
        db,
        organisationId: organisation.organisationId,
        membership: organisation.membership,
        now: NOW,
      }),
    ).resolves.toEqual({
      schema_version: 1,
      projection_revision: 1,
      configuration_version: 1,
      organisation: {
        organisation_id: organisation.organisationId,
        name: "Projection Commerce",
        plan: "beta",
        lifecycle: {
          kind: "configuring",
          organisation_id: organisation.organisationId,
          configuration_version: 1,
          environment: "development",
        },
        capability_profile: "read_and_propose",
        created_at: NOW,
      },
      membership: {
        user_id: owner.userId,
        person_id: organisation.personId,
        role: "owner",
        created_at: NOW,
      },
      steps: [
        {
          kind: "complete",
          step: "workspace",
          completed_at: NOW,
          receipt_id: expect.any(String),
        },
        { kind: "available", step: "inference", action: "choose_inference" },
        { kind: "available", step: "commerce", action: "connect_commerce" },
        { kind: "available", step: "conversations", action: "connect_slack" },
        {
          kind: "unavailable",
          step: "operating_profile",
          reason_code: "provider_accounts_required",
        },
        {
          kind: "unavailable",
          step: "review_activation",
          reason_code: "readiness_required",
        },
      ],
      provider_accounts: [],
      operating_profile: { kind: "unconfigured" },
      readiness: {
        kind: "blocked",
        readiness_version: 0,
        readiness_hash: "unassessed",
        configuration_version: 1,
        blockers: [{ code: "readiness_not_evaluated" }],
        approval_authentication: [],
        assessed_at: 0,
      },
      activation: {
        kind: "idle",
        organisation_id: organisation.organisationId,
      },
      next_action: {
        kind: "perform",
        action_code: "choose_inference",
        label: "Choose AI account",
        route: `/portal/${organisation.organisationId}/integrations`,
        presentation: "same_page",
        retry_safety: "safe",
      },
      first_task: null,
      support_reference: { kind: "none" },
      updated_at: NOW,
    });

    const gmailAttempt = await createAuthorizingProviderAttempt({
      db,
      organisationId: organisation.organisationId,
      provider: "gmail",
      userId: owner.userId,
      existingIntegrationAccountId: null,
      purpose: "connect",
      portalSubjectHash: "projection-subject-hash",
      stateHash: await hashOpaqueSecret("projection-gmail-state"),
      nonceHash: await hashOpaqueSecret("projection-gmail-nonce"),
      pkceVerifier: "projection-gmail-verifier",
      providerContext: JSON.stringify({ provider: "gmail" }),
      returnPath: `/portal/${organisation.organisationId}/integrations`,
      expiresAt: NOW + 600_000,
      mutation: {
        boundary: {
          kind: "configuration_versioned",
          idempotencyKey: "projection-gmail-start",
          requestHash: "a".repeat(64),
          expectedConfigurationVersion: 1,
        },
        scope: {
          userId: owner.userId,
          organisationScope: organisation.organisationId,
          route: `/v1/control/organisations/${organisation.organisationId}/providers/gmail/start`,
          operation: "provider.attempt.start",
        },
        identity: newControlMutationIdentity({
          portalSubjectHash: "projection-subject-hash",
          causationId: "projection-gmail-start-request",
          now: NOW + 1,
        }),
      },
      now: NOW + 1,
    });
    expect(gmailAttempt.ok).toBe(true);
    const afterGmail = await buildOnboardingProjection({
      db,
      organisationId: organisation.organisationId,
      membership: organisation.membership,
      now: NOW,
    });
    if (afterGmail === null) {
      throw new Error("projection after gmail attempt returned no projection");
    }
    expect(afterGmail.steps).toContainEqual({
      kind: "available",
      step: "commerce",
      action: "connect_commerce",
    });
    expect(afterGmail.next_action).toMatchObject({
      kind: "perform",
      action_code: "choose_inference",
    });

    const shopifyAttempt = await createAuthorizingProviderAttempt({
      db,
      organisationId: organisation.organisationId,
      provider: "shopify",
      userId: owner.userId,
      existingIntegrationAccountId: null,
      purpose: "connect",
      portalSubjectHash: "projection-subject-hash",
      stateHash: await hashOpaqueSecret("projection-shopify-state"),
      nonceHash: await hashOpaqueSecret("projection-shopify-nonce"),
      pkceVerifier: "projection-shopify-verifier",
      providerContext: JSON.stringify({
        provider: "shopify",
        shopDomain: "projection.myshopify.com",
      }),
      returnPath: `/portal/${organisation.organisationId}/integrations`,
      expiresAt: NOW + 600_000,
      mutation: {
        boundary: {
          kind: "configuration_versioned",
          idempotencyKey: "projection-shopify-start",
          requestHash: "b".repeat(64),
          expectedConfigurationVersion: 1,
        },
        scope: {
          userId: owner.userId,
          organisationScope: organisation.organisationId,
          route: `/v1/control/organisations/${organisation.organisationId}/providers/shopify/start`,
          operation: "provider.attempt.start",
        },
        identity: newControlMutationIdentity({
          portalSubjectHash: "projection-subject-hash",
          causationId: "projection-shopify-start-request",
          now: NOW + 2,
        }),
      },
      now: NOW + 2,
    });
    if (!shopifyAttempt.ok) {
      throw new Error("projection shopify attempt was rejected");
    }
    const afterShopify = await buildOnboardingProjection({
      db,
      organisationId: organisation.organisationId,
      membership: organisation.membership,
      now: NOW,
    });
    if (afterShopify === null) {
      throw new Error(
        "projection after shopify attempt returned no projection",
      );
    }
    expect(afterShopify.steps).toContainEqual({
      kind: "in_progress",
      step: "commerce",
      attempt_id: shopifyAttempt.value.attempt.attemptId,
      started_at: NOW + 2,
    });

    const afterDeadline = await buildOnboardingProjection({
      db,
      organisationId: organisation.organisationId,
      membership: organisation.membership,
      now: NOW + 600_000,
    });
    if (afterDeadline === null) {
      throw new Error(
        "projection after attempt deadline returned no projection",
      );
    }
    expect(afterDeadline.steps).toContainEqual({
      kind: "action_required",
      step: "commerce",
      reason_code: "authorization_expired",
      action: "connect_commerce",
    });
  });

  it("projects account scopes, selected resources, and connection health without secrets", async () => {
    const db = createMigratedDatabase();
    const owner = await upsertUser({
      db,
      identity: {
        issuer: "https://accounts.google.com",
        subject: "projection-details-owner",
        email: "projection-details@example.com",
        displayName: "Projection Details Owner",
        emailVerified: true,
      },
      now: NOW,
    });
    const organisation = await requireOrganisationBootstrap({
      env: {
        DB: db,
        SATYR_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      owner,
      organisationName: "Projection Details",
      environment: "development",
      mutation: organisationBootstrapMutation(owner, NOW),
      placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
      now: NOW,
    });
    const slackCredential = parseVaultHandle("vault:projection:slack:g1");
    const stripeCredential = parseVaultHandle("vault:projection:stripe:g1");
    if (!slackCredential.ok || !stripeCredential.ok) {
      throw new Error("projection test vault handles are invalid");
    }
    const slack = await createConnectedIntegration(db, {
      organisationId: organisation.organisationId,
      provider: "slack",
      providerSubjectId: "projection-workspace",
      environment: "development",
      authMode: "shared_satyr_app",
      authority: {
        kind: "connection_credential",
        credentialRef: slackCredential.value,
      },
      grantedScopes: ["channels:read", "chat:write"],
      createdByUserId: owner.userId,
      providerAccountId: "projection-workspace",
      accountKind: "workspace",
      displayName: "Projection Slack",
      capabilities: ["conversation.ingress"],
      audiencePolicy: { kind: "operator" },
      retentionPolicy: { kind: "organisation_default" },
      now: NOW + 1,
    });
    const stripe = await createConnectedIntegration(db, {
      organisationId: organisation.organisationId,
      provider: "stripe",
      providerSubjectId: "acct_projection",
      environment: "development",
      authMode: "api_key",
      authority: {
        kind: "connection_credential",
        credentialRef: stripeCredential.value,
      },
      grantedScopes: ["payments:read"],
      createdByUserId: owner.userId,
      providerAccountId: "acct_projection",
      accountKind: "account",
      displayName: "Projection Stripe",
      capabilities: ["commerce.read"],
      audiencePolicy: { kind: "operator" },
      retentionPolicy: { kind: "organisation_default" },
      now: NOW + 2,
    });
    await finalizeConnectedIntegrationAccount({
      db,
      organisationId: organisation.organisationId,
      integrationAccountId: slack.account.integrationAccountId,
      now: NOW + 3,
    });
    await finalizeConnectedIntegrationAccount({
      db,
      organisationId: organisation.organisationId,
      integrationAccountId: stripe.account.integrationAccountId,
      now: NOW + 3,
    });
    await upsertSurfaceInstallation({
      db,
      account: slack.account,
      surfaceKind: "slack",
      workspaceId: "projection-workspace",
      installModel: "unlisted",
      botTokenRef: slackCredential.value,
      scopes: ["channels:read", "chat:write"],
      installedAt: NOW + 3,
    });
    await db
      .prepare(
        `UPDATE surface_installation
       SET last_event_received_at = ?
       WHERE integration_account_id = ?`,
      )
      .bind(NOW + 4, slack.account.integrationAccountId)
      .run();
    await db
      .prepare(
        `INSERT INTO provider_webhook (
         provider_webhook_id, organisation_id, integration_account_id, provider,
         provider_native_id, event_type, lifecycle, lifecycle_reason_code,
         signing_secret_ref, credential_generation, last_verified_at, updated_at,
         environment
       ) VALUES (?, ?, ?, 'slack', ?, 'message', 'live', NULL, ?, 1, ?, ?, 'development')`,
      )
      .bind(
        "webhook_projection_slack",
        organisation.organisationId,
        slack.account.integrationAccountId,
        "projection-webhook",
        "vault:projection:slack:signing",
        NOW + 4,
        NOW + 4,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO provider_webhook (
         provider_webhook_id, organisation_id, integration_account_id, provider,
         provider_native_id, event_type, lifecycle, lifecycle_reason_code,
         signing_secret_ref, credential_generation, last_verified_at, updated_at,
         environment
       ) VALUES (?, ?, ?, 'slack', ?, 'reaction', 'disabled', NULL, ?, 2, NULL, ?, 'development')`,
      )
      .bind(
        "webhook_projection_slack_disabled",
        organisation.organisationId,
        slack.account.integrationAccountId,
        "projection-webhook-disabled",
        "vault:projection:slack:signing",
        NOW + 4,
      )
      .run();
    await persistProviderResourceSnapshot({
      db,
      organisationId: organisation.organisationId,
      integrationAccountId: stripe.account.integrationAccountId,
      provider: "stripe",
      environment: "development",
      resources: [
        {
          canonicalResourceId: "acct_projection",
          providerResourceId: "acct_projection",
          providerAccountId: "acct_projection",
          displayLabel: "Projection Stripe",
          accessState: "accessible",
          providerRevision: "stripe-projection-1",
          resourceKind: "account",
        },
      ],
      now: NOW + 5,
    });
    await persistProviderResourceSnapshot({
      db,
      organisationId: organisation.organisationId,
      integrationAccountId: slack.account.integrationAccountId,
      provider: "slack",
      environment: "development",
      resources: [
        {
          canonicalResourceId: "C123",
          providerResourceId: "C123",
          providerAccountId: "projection-workspace",
          displayLabel: "C123",
          accessState: "accessible",
          providerRevision: "slack-projection-1",
          resourceKind: "channel",
        },
      ],
      now: NOW + 6,
    });
    await db
      .prepare(
        `INSERT INTO organisation_onboarding_selection (
         organisation_id, policy_template_id, policy_template_version,
         cue_preset_id, cue_preset_version, cue_workspace_id, cue_channel_id,
         selected_by_user_id, selected_at
       ) VALUES (?, 'commerce_operator', 1, 'commerce_operator', 1, 'projection-workspace', 'C123', ?, ?)`,
      )
      .bind(organisation.organisationId, owner.userId, NOW + 5)
      .run();
    await db
      .prepare(
        `INSERT INTO organisation_communication_destination (
         organisation_id, integration_account_id, workspace_id, channel_id,
         provider_revision, selected_at
       ) VALUES (?, ?, 'projection-workspace', 'C123', ?, ?)`,
      )
      .bind(
        organisation.organisationId,
        slack.account.integrationAccountId,
        "slack-projection-1",
        NOW + 6,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO organisation_slack_channel (
         organisation_id, integration_account_id, workspace_id, channel_id,
         provider_revision, connected_at
       ) VALUES (?, ?, 'projection-workspace', 'C123', ?, ?)`,
      )
      .bind(
        organisation.organisationId,
        slack.account.integrationAccountId,
        "slack-projection-1",
        NOW + 6,
      )
      .run();

    const projection = await buildOnboardingProjection({
      db,
      organisationId: organisation.organisationId,
      membership: organisation.membership,
      now: NOW,
    });
    if (projection === null) {
      throw new Error("projection details test returned no projection");
    }
    const projectedSlack = projection.provider_accounts.find(
      (account) =>
        account.integration_account_id === slack.account.integrationAccountId,
    );
    const projectedStripe = projection.provider_accounts.find(
      (account) =>
        account.integration_account_id === stripe.account.integrationAccountId,
    );
    expect(projectedSlack).toMatchObject({
      scopes: ["channels:read", "chat:write"],
      selected_resources: [
        { resource_kind: "workspace", display_label: "Slack workspace" },
        { resource_kind: "channel", display_label: "Slack channel" },
      ],
      credential_health: { kind: "healthy" },
      webhook_health: { kind: "healthy" },
      event_recency: { kind: "available", at: NOW + 4 },
    });
    expect(projectedStripe).toMatchObject({
      scopes: ["payments:read"],
      selected_resources: [],
      credential_health: { kind: "healthy" },
      webhook_health: { kind: "missing" },
      event_recency: { kind: "unavailable" },
    });
    expect(projection.steps).toContainEqual({
      kind: "available",
      step: "commerce",
      action: "connect_commerce",
    });
  });
});
