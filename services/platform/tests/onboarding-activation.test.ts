import type { SingleDatabase } from "../src/database-handles";
import { requireOrganisationBootstrap } from "./organisation-execution-fixture";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
import { describe, expect, it } from "vitest";

import {
  beginOnboardingActivation,
  checkpointActivationStep,
  completeOnboardingActivation,
  failOnboardingActivation,
  type ActivationContext,
} from "../src/data/activation";
import { upsertUser } from "../src/data/control-plane";
import {
  newControlMutationIdentity,
  readControlMutationReplay,
} from "../src/data/control-mutation";
import {
  armOnboardingActivationAcceptanceFault,
  consumeOnboardingActivationAcceptanceFault,
  inspectOnboardingActivationAcceptanceFault,
  type OnboardingActivationAcceptanceFaultStorage,
} from "../src/organisation/contract/onboarding-activation-acceptance-fault";
import { newRequestId, type OrganisationId } from "../src/ids";
import { type UserId } from "@purin-labs/control-api/ids";
import {
  evaluateAndStoreReadiness,
  ensureCurrentReadiness,
  loadSetupSelection,
  readCurrentReadiness,
  selectSetupTemplates,
} from "../src/data/onboarding";
import { buildOnboardingProjection } from "../src/data/onboarding-projection";
import { readMerchantSupportDiagnostics } from "../src/data/onboarding-support";
import {
  recordProviderStartFailure,
} from "../src/organisation/contract/provider-support-references";
import { organisationBootstrapMutation } from "./control-mutation-fixture";
import { TEST_INITIAL_ORGANISATION_PLACEMENT } from "./fixtures/organisation-placement";
import { isRecord } from "@purin-labs/std";
import { createMigratedDatabase } from "./sqlite-d1";
import { requireWorkspaceId, requireChannelId } from "./test-ids";
import { resolveActiveOrganisationPlacementRecord } from "../src/data/organisation-placement";
import type { LifecycleFence } from "../src/data/organisation-lifecycle-moves";

/** The placement that the Organisation Actor admits an activation under. */
async function activationFence(
  db: Parameters<typeof resolveActiveOrganisationPlacementRecord>[0],
  organisationId: LifecycleFence["organisationId"],
): Promise<LifecycleFence> {
  const placement = await resolveActiveOrganisationPlacementRecord(
    db,
    organisationId,
  );
  if (!placement.ok) throw new Error(placement.error.code);
  return {
    organisationId,
    placement: placement.value.placement,
    fenceToken: placement.value.fenceToken,
  };
}

const NOW = 1_783_987_896_426;

describe("onboarding activation", () => {
  it(
    "retains the accepted Slack destination receipt without changing its credential",
    setupReplayPreservesSlackCredential,
  );

  it("loads the saved onboarding selection for the portal", async () => {
    const db = createMigratedDatabase();
    const owner = await upsertUser({
      db,
      identity: {
        issuer: "https://accounts.google.com",
        subject: "setup-owner",
        email: "setup@example.com",
        displayName: "Setup Owner",
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
      organisationName: "Setup Commerce",
      environment: "development",
      mutation: organisationBootstrapMutation(owner, NOW),
      placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
      now: NOW,
    });
    await seedReadyOnboarding(db, organisation.organisationId, owner.userId);

    await expect(
      loadSetupSelection({
        db,
        organisationId: organisation.organisationId,
        capabilityProfile: "read_and_propose",
      }),
    ).resolves.toEqual({
      policyTemplateId: "commerce_operator",
      capabilityProfile: "read_and_propose",
      cuePresetId: "observe_commerce",
      cueTarget: {
        workspaceId: "activation-workspace",
        channelId: "activation-channel",
      },
    });
  });

  it("reports a policy-selected non-default approval branch without blocking readiness", async () => {
    const db = createMigratedDatabase();
    const owner = await upsertUser({
      db,
      identity: {
        issuer: "https://accounts.google.com",
        subject: "auth-readiness-owner",
        email: "auth-readiness@example.com",
        displayName: "Auth Readiness Owner",
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
      organisationName: "Auth Readiness Commerce",
      environment: "development",
      mutation: organisationBootstrapMutation(owner, NOW),
      placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
      now: NOW,
    });
    await seedReadyApprovedProviderWritesOnboarding(
      db,
      organisation.organisationId,
      owner.userId,
    );
    await db
      .prepare(
        `UPDATE organisation_setup_snapshot SET body = ?
       WHERE organisation_id = ? AND snapshot_kind = 'policy'`,
      )
      .bind(
        JSON.stringify({
          templateId: "commerce_operator",
          version: 1,
          capabilityProfile: "approved_provider_writes",
          outputScreeningMode: "stream",
          highStakesWrites: "approval_required",
          approvalAuthentication: { highStakes: "seams_nep413" },
        }),
        organisation.organisationId,
      )
      .run();

    const readiness = await evaluateAndStoreReadiness({
      db,
      organisationId: organisation.organisationId,
      fence: await activationFence(db, organisation.organisationId),
      now: NOW + 1,
      runtimeAdmission: "available",
      commerceSystemReadiness: "ready",
    });
    expect(readiness.kind).toBe("ready");
    expect(readiness.approvalAuthentication).toEqual([
      {
        action_class: "high_stakes",
        branch: "seams_nep413",
        ready: false,
        reason: "seams_identity_unlinked",
      },
    ]);

    const persisted = await readCurrentReadiness({
      db,
      organisationId: organisation.organisationId,
    });
    expect(persisted?.approvalAuthentication).toEqual([
      {
        action_class: "high_stakes",
        branch: "seams_nep413",
        ready: false,
        reason: "seams_identity_unlinked",
      },
    ]);
  });

  it("reports no approval branch for the default Google step-up policy", async () => {
    const db = createMigratedDatabase();
    const owner = await upsertUser({
      db,
      identity: {
        issuer: "https://accounts.google.com",
        subject: "auth-default-owner",
        email: "auth-default@example.com",
        displayName: "Auth Default Owner",
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
      organisationName: "Auth Default Commerce",
      environment: "development",
      mutation: organisationBootstrapMutation(owner, NOW),
      placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
      now: NOW,
    });
    await seedReadyApprovedProviderWritesOnboarding(
      db,
      organisation.organisationId,
      owner.userId,
    );

    const readiness = await evaluateAndStoreReadiness({
      db,
      organisationId: organisation.organisationId,
      fence: await activationFence(db, organisation.organisationId),
      now: NOW + 1,
      runtimeAdmission: "available",
      commerceSystemReadiness: "ready",
    });
    expect(readiness).toMatchObject({
      kind: "ready",
      capabilityProfile: "approved_provider_writes",
    });
    expect(readiness.approvalAuthentication).toEqual([]);
  });

  it("uses the activation receipt for active organisations with an older setup projection", async () => {
    const db = createMigratedDatabase();
    const owner = await upsertUser({
      db,
      identity: {
        issuer: "https://accounts.google.com",
        subject: "active-legacy-owner",
        email: "active-legacy@example.com",
        displayName: "Active Legacy Owner",
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
      organisationName: "Active Legacy Commerce",
      environment: "development",
      mutation: organisationBootstrapMutation(owner, NOW),
      placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
      now: NOW,
    });
    await seedReadyOnboarding(db, organisation.organisationId, owner.userId);
    await db.withSession("first-primary").batch([
      db
        .prepare(
          `INSERT INTO organisation_activation_attempt (
           activation_attempt_id, organisation_id, readiness_version, readiness_hash,
           status, failure_code, retryable, started_at, updated_at, completed_at,
           environment
         ) VALUES ('legacy-active-attempt', ?, 7, 'legacy-active-readiness',
           'completed', NULL, NULL, ?, ?, ?, 'development')`,
        )
        .bind(organisation.organisationId, NOW, NOW, NOW),
      db
        .prepare(
          `INSERT INTO organisation_activation_receipt (
           activation_receipt_id, activation_attempt_id, organisation_id, readiness_hash,
           policy_snapshot_id, cue_snapshot_id, capability_profile, activated_at,
           environment
         ) VALUES ('legacy-active-receipt', 'legacy-active-attempt', ?,
           'legacy-active-readiness', 'setup_snapshot_policy', 'setup_snapshot_cue',
           'read_and_propose', ?, 'development')`,
        )
        .bind(organisation.organisationId, NOW),
      db
        .prepare(
          `UPDATE organisation_onboarding
         SET lifecycle = 'active', activation_attempt_id = NULL,
             readiness_version = NULL, activation_receipt_id = 'legacy-active-receipt',
             activated_at = ?, updated_at = ?
         WHERE organisation_id = ?`,
        )
        .bind(NOW, NOW, organisation.organisationId),
      db
        .prepare(
          `DELETE FROM organisation_readiness_assessment WHERE organisation_id = ?`,
        )
        .bind(organisation.organisationId),
      db
        .prepare(
          `DELETE FROM organisation_communication_destination WHERE organisation_id = ?`,
        )
        .bind(organisation.organisationId),
    ]);

    const projection = await buildOnboardingProjection({
      db,
      organisationId: organisation.organisationId,
      membership: organisation.membership,
      now: NOW,
    });
    expect(projection?.readiness).toMatchObject({
      kind: "ready",
      readiness_version: 7,
      readiness_hash: "legacy-active-readiness",
      configuration_version: 1,
    });
    expect(projection?.steps).toContainEqual({
      kind: "complete",
      step: "operating_profile",
      completed_at: NOW,
      receipt_id: "setup:1",
    });
  });

  it("blocks activation until the selected commerce system has accepted a resource", async () => {
    const db = createMigratedDatabase();
    const owner = await upsertUser({
      db,
      identity: {
        issuer: "https://accounts.google.com",
        subject: "commerce-sync-owner",
        email: "commerce-sync@example.com",
        displayName: "Commerce Sync Owner",
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
      organisationName: "Commerce Sync",
      environment: "development",
      mutation: organisationBootstrapMutation(owner, NOW),
      placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
      now: NOW,
    });
    await seedReadyApprovedProviderWritesOnboarding(
      db,
      organisation.organisationId,
      owner.userId,
    );

    const syncing = await ensureCurrentReadiness({
      db,
      organisationId: organisation.organisationId,
      fence: await activationFence(db, organisation.organisationId),
      now: NOW + 1,
      runtimeAdmission: "available",
      commerceSystemReadiness: "syncing",
    });
    expect(syncing).toMatchObject({
      kind: "blocked",
      blockers: [{ code: "commerce_system_missing" }],
    });

    const ready = await ensureCurrentReadiness({
      db,
      organisationId: organisation.organisationId,
      fence: await activationFence(db, organisation.organisationId),
      now: NOW + 2,
      runtimeAdmission: "available",
      commerceSystemReadiness: "ready",
    });
    expect(ready).toMatchObject({ kind: "ready", readinessVersion: 2 });
  });

  it("re-evaluates a stale assessment when configuration changed behind it", async () => {
    const db = createMigratedDatabase();
    const owner = await upsertUser({
      db,
      identity: {
        issuer: "https://accounts.google.com",
        subject: "stale-readiness-owner",
        email: "stale-readiness@example.com",
        displayName: "Stale Readiness Owner",
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
      organisationName: "Stale Readiness",
      environment: "development",
      mutation: organisationBootstrapMutation(owner, NOW),
      placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
      now: NOW,
    });

    await seedReadyOnboarding(db, organisation.organisationId, owner.userId);
    // Make the stored assessment claim blockers the configuration has already
    // cleared — the state the old staleness gate could never recover from,
    // since it only sampled the runtime-admission and commerce-sync signals.
    await db.withSession("first-primary").batch([
      db
        .prepare(
          `UPDATE organisation_readiness_assessment
         SET blockers = '[{"code":"communication_connection_missing"},{"code":"commerce_system_missing"}]'
         WHERE organisation_id = ? AND readiness_version = 1`,
        )
        .bind(organisation.organisationId),
    ]);
    await expect(
      readCurrentReadiness({
        db,
        organisationId: organisation.organisationId,
      }),
    ).resolves.toMatchObject({ kind: "blocked", readinessVersion: 1 });

    // Even with both live signals unknown — the only inputs the old gate
    // sampled — the read path must notice the configuration drift and store a
    // fresh assessment instead of serving the stale blockers forever.
    const after = await ensureCurrentReadiness({
      db,
      organisationId: organisation.organisationId,
      fence: await activationFence(db, organisation.organisationId),
      now: NOW + 2,
      runtimeAdmission: "unknown",
      commerceSystemReadiness: "unknown",
    });
    if (after === null) throw new Error("expected a refreshed assessment");
    expect(after.readinessVersion).toBeGreaterThan(1);
    const afterBlockers = after.kind === "blocked" ? after.blockers : [];
    expect(afterBlockers).not.toEqual(
      expect.arrayContaining([{ code: "communication_connection_missing" }]),
    );

    // Unchanged state stores nothing new: no version churn on plain reads.
    const again = await ensureCurrentReadiness({
      db,
      organisationId: organisation.organisationId,
      fence: await activationFence(db, organisation.organisationId),
      now: NOW + 3,
      runtimeAdmission: "unknown",
      commerceSystemReadiness: "unknown",
    });
    expect(again?.readinessVersion).toBe(after.readinessVersion);
  });

  it("replays checkpoints, resumes a failed attempt, and returns one completion receipt", async () => {
    const db = createMigratedDatabase();
    const owner = await upsertUser({
      db,
      identity: {
        issuer: "https://accounts.google.com",
        subject: "activation-owner",
        email: "activation@example.com",
        displayName: "Activation Owner",
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
      organisationName: "Activation Commerce",
      environment: "development",
      mutation: organisationBootstrapMutation(owner, NOW),
      placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
      now: NOW,
    });
    await seedReadyOnboarding(db, organisation.organisationId, owner.userId);

    const request = activationRequest(
      organisation.organisationId,
      owner.userId,
      "activate-idempotency-0001",
      NOW + 1,
    );
    const started = await beginOnboardingActivation({
      db,
      request,
      fence: await activationFence(db, organisation.organisationId),
    });
    expect(started.ok).toBe(true);
    if (!started.ok || started.value.kind !== "run") {
      throw new Error("activation did not start");
    }
    const initialContext = started.value.context;
    expect([...initialContext.completedSteps]).toEqual([]);

    await checkpointActivationStep({
      db,
      context: initialContext,
      step: "readiness",
      receipt: { readinessHash: initialContext.readinessHash },
      now: NOW + 2,
    });
    await checkpointActivationStep({
      db,
      context: initialContext,
      step: "placement",
      receipt: { placement: "ready" },
      now: NOW + 2,
    });
    await failOnboardingActivation({
      db,
      context: initialContext,
      failureCode: "activation_interrupted",
      retryable: true,
      now: NOW + 3,
    });
    await expect(
      countOpenSupportReferences(db, organisation.organisationId),
    ).resolves.toBe(1);

    const resumed = await beginOnboardingActivation({
      db,
      fence: await activationFence(db, organisation.organisationId),
      request: activationRequest(
        organisation.organisationId,
        owner.userId,
        "activate-idempotency-0002",
        NOW + 4,
      ),
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok || resumed.value.kind !== "run") {
      throw new Error("activation did not resume");
    }
    expect(resumed.value.context.attemptId).toBe(initialContext.attemptId);
    expect([...resumed.value.context.completedSteps].sort()).toEqual([
      "placement",
      "readiness",
    ]);

    const receipt = await completeOnboardingActivation({
      db,
      context: resumed.value.context,
      now: NOW + 5,
    });
    await expect(
      countOpenSupportReferences(db, organisation.organisationId),
    ).resolves.toBe(0);
    await expect(
      readReadProposeCapabilityEvidence(db, organisation.organisationId),
    ).resolves.toEqual({
      capabilityProfile: "read_and_propose",
      highStakesWrites: "disabled",
      enabledProviderWriteTools: 0,
    });
    expect(receipt.capabilityProfile).toBe("read_and_propose");
    const replayed = await beginOnboardingActivation({
      db,
      fence: await activationFence(db, organisation.organisationId),
      request: activationRequest(
        organisation.organisationId,
        owner.userId,
        "activate-idempotency-0002",
        NOW + 6,
      ),
    });
    expect(replayed).toEqual({
      ok: true,
      value: { kind: "completed", receipt },
    });
  });

  it("activates a fresh Seams Checkout organisation with Slack and no external commerce account", async () => {
    const db = createMigratedDatabase();
    const owner = await upsertUser({
      db,
      identity: {
        issuer: "https://accounts.google.com",
        subject: "builtin-commerce-owner",
        email: "builtin-commerce@example.com",
        displayName: "Seams Checkout Owner",
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
      organisationName: "Seams Checkout Cafe",
      environment: "development",
      mutation: organisationBootstrapMutation(owner, NOW),
      placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
      now: NOW,
    });
    await seedReadyOnboarding(db, organisation.organisationId, owner.userId);
    await replaceShopifyWithPantryCommerce(
      db,
      organisation.organisationId,
      owner.userId,
    );

    const started = await beginOnboardingActivation({
      db,
      fence: await activationFence(db, organisation.organisationId),
      request: activationRequest(
        organisation.organisationId,
        owner.userId,
        "activate-builtin-commerce-0001",
        NOW + 1,
      ),
    });
    if (!started.ok || started.value.kind !== "run") {
      throw new Error("Seams Checkout activation did not start");
    }
    await checkpointActivationStep({
      db,
      context: started.value.context,
      step: "readiness",
      receipt: { readinessHash: started.value.context.readinessHash },
      now: NOW + 2,
    });
    await checkpointActivationStep({
      db,
      context: started.value.context,
      step: "placement",
      receipt: { placement: "ready" },
      now: NOW + 3,
    });
    await checkpointRemainingActivationSteps(
      db,
      started.value.context,
      NOW + 4,
    );
    const receipt = await completeOnboardingActivation({
      db,
      context: started.value.context,
      now: NOW + 8,
    });

    expect(receipt).toMatchObject({ capabilityProfile: "read_and_propose" });
    await expect(
      readPantryCommerceActivationEvidence(db, organisation.organisationId),
    ).resolves.toEqual({
      lifecycle: "active",
      systemKind: "builtin_commerce",
      commerceSystemRevision: 1,
      destinationId: "activation-channel",
      shopifyAccounts: 0,
      stripeAccounts: 0,
      slackAccounts: 1,
    });
  });

  it(
    "consumes the one-shot interruption and resumes the same attempt to one receipt",
    interruptedActivationRecoveryAcceptanceTest,
  );

  it(
    "rejects readiness invalidated by a canonical setup change",
    staleReadinessRejectionTest,
  );

  it(
    "keeps diagnostic reads from advancing readiness or activation",
    diagnosticReadSafetyTest,
  );
});

async function setupReplayPreservesSlackCredential(): Promise<void> {
  const db = createMigratedDatabase();
  const owner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "setup-replay-owner",
      email: "setup-replay@example.com",
      displayName: "Setup Replay Owner",
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
    organisationName: "Setup Replay Commerce",
    environment: "development",
    mutation: organisationBootstrapMutation(owner, NOW),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: NOW,
  });
  await seedReadyApprovedProviderWritesOnboarding(
    db,
    organisation.organisationId,
    owner.userId,
  );
  const before = await readSlackCredentialEvidence(
    db,
    organisation.organisationId,
  );
  const scope = await requireOrganisationExecutionScope(
    {
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    organisation.organisationId,
  );
  const mutation = setupMutation(
    organisation.organisationId,
    owner.userId,
    "setup-destination-replay-0001",
    NOW + 1,
  );
  const first = await selectSetupTemplates({
    scope,
    selectedByUserId: owner.userId,
    selection: {
      policyTemplateId: "commerce_operator",
      capabilityProfile: "approved_provider_writes",
      cuePresetId: "observe_commerce",
      cueTarget: {
        workspaceId: requireWorkspaceId("activation-workspace"),
        channelId: requireChannelId("activation-channel"),
      },
    },
    mutation,
    now: NOW + 1,
  });
  if (!first.ok) throw new Error(first.error.code);
  const afterFirst = await readSetupReplayEvidence(
    db,
    organisation.organisationId,
  );

  const replay = await readControlMutationReplay({
    db,
    scope: mutation.scope,
    boundary: mutation.boundary,
  });
  expect(replay.kind).toBe("replay");
  if (replay.kind !== "replay")
    throw new Error("The accepted native setup receipt is missing");
  expect(replay.receipt.responseBody).toEqual({
    receipt_id: first.value.receiptId,
    organisation_id: organisation.organisationId,
  });
  const afterReplay = await readSetupReplayEvidence(
    db,
    organisation.organisationId,
  );
  const afterCredential = await readSlackCredentialEvidence(
    db,
    organisation.organisationId,
  );

  expect(afterFirst).toEqual({
    configurationVersion: 2,
    destinationCount: 1,
    workspaceId: "activation-workspace",
    channelId: "activation-channel",
    receiptCount: 1,
  });
  expect(afterReplay).toEqual(afterFirst);
  expect(afterCredential).toEqual(before);
  expect(afterCredential).toEqual({
    credentialGeneration: 1,
    credentialRef: "vault:activation:slack",
    generationCount: 1,
    activeGenerationCount: 1,
  });
}

async function staleReadinessRejectionTest(): Promise<void> {
  const db = createMigratedDatabase();
  const owner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "stale-readiness-owner",
      email: "stale-readiness@example.com",
      displayName: "Stale Readiness Owner",
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
    organisationName: "Stale Readiness Commerce",
    environment: "development",
    mutation: organisationBootstrapMutation(owner, NOW),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: NOW,
  });
  await seedReadyOnboarding(db, organisation.organisationId, owner.userId);
  const selection = await loadSetupSelection({
    db,
    organisationId: organisation.organisationId,
    capabilityProfile: "read_and_propose",
  });
  if (selection === null) {
    throw new Error("ready onboarding selection is missing");
  }

  await db
    .prepare(
      "UPDATE integration_account SET is_default_for_provider = 0 WHERE organisation_id = ? AND provider = 'slack'",
    )
    .bind(organisation.organisationId)
    .run();

  const changed = await selectSetupTemplates({
    scope: await requireOrganisationExecutionScope(
      {
        DB: db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      organisation.organisationId,
    ),

    selectedByUserId: owner.userId,
    selection: {
      policyTemplateId: selection.policyTemplateId,
      capabilityProfile: selection.capabilityProfile,
      cuePresetId: "commerce_operator",
      cueTarget: {
        workspaceId: selection.cueTarget.workspaceId,
        channelId: selection.cueTarget.channelId,
      },
    },
    mutation: setupMutation(
      organisation.organisationId,
      owner.userId,
      "setup-stale-readiness-0001",
      NOW + 1,
    ),
    now: NOW + 1,
  });
  expect(changed.ok).toBe(true);
  if (!changed.ok) {
    throw new Error("canonical setup change failed");
  }
  expect(changed.value.configurationVersion).toBe(2);

  await expect(
    beginOnboardingActivation({
      db,
      fence: await activationFence(db, organisation.organisationId),
      request: activationRequest(
        organisation.organisationId,
        owner.userId,
        "activate-stale-readiness-0001",
        NOW + 2,
      ),
    }),
  ).resolves.toEqual({
    ok: false,
    error: {
      code: "activation_readiness_stale",
      detail: "configuration_changed_since_assessment",
    },
  });

  await expect(
    readStaleReadinessEvidence(db, organisation.organisationId),
  ).resolves.toEqual({
    lifecycle: "configuring",
    configurationVersion: 2,
    readinessVersion: null,
    activationAttemptId: null,
    activationReceiptId: null,
    attemptCount: 0,
    receiptCount: 0,
  });
  const projection = await buildOnboardingProjection({
    db,
    organisationId: organisation.organisationId,
    membership: organisation.membership,
    now: NOW,
  });
  expect(projection?.configuration_version).toBe(2);
  expect(projection?.readiness).toMatchObject({
    kind: "blocked",
    readiness_version: 0,
    configuration_version: 2,
    blockers: [{ code: "readiness_not_evaluated" }],
  });
  expect(projection?.activation).toEqual({
    kind: "idle",
    organisation_id: organisation.organisationId,
  });
}

async function diagnosticReadSafetyTest(): Promise<void> {
  const db = createMigratedDatabase();
  const owner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "diagnostic-read-owner",
      email: "diagnostic-read@example.com",
      displayName: "Diagnostic Read Owner",
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
    organisationName: "Diagnostic Read Commerce",
    environment: "development",
    mutation: organisationBootstrapMutation(owner, NOW),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: NOW,
  });
  await seedReadyOnboarding(db, organisation.organisationId, owner.userId);

  const failure = await recordProviderStartFailure({
    db,
    organisationId: organisation.organisationId,
    environment: "development",
    actorUserId: owner.userId,
    provider: "gmail",
    route: `/v1/control/organisations/${organisation.organisationId}/providers/gmail/start`,
    reasonCode: "provider_temporarily_unavailable",
    retryable: true,
    now: NOW + 1,
  });
  const before = await readDiagnosticReadSafetyEvidence(
    db,
    organisation.organisationId,
  );

  await expect(
    readMerchantSupportDiagnostics({
      db,
      organisationId: organisation.organisationId,
      supportReference: failure.supportReference,
    }),
  ).resolves.toMatchObject({
    ok: true,
    value: {
      kind: "support_diagnostics",
      supportReference: failure.supportReference,
      provider: "gmail",
      reasonCode: "provider_temporarily_unavailable",
      retryStatus: "retryable",
    },
  });

  await expect(
    readDiagnosticReadSafetyEvidence(db, organisation.organisationId),
  ).resolves.toEqual(before);
}

async function interruptedActivationRecoveryAcceptanceTest(): Promise<void> {
  const db = createMigratedDatabase();
  const storage = new MemoryActivationFaultStorage();
  const owner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "interrupted-activation-owner",
      email: "interrupted-activation@example.com",
      displayName: "Interrupted Activation Owner",
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
    organisationName: "Interrupted Activation Commerce",
    environment: "development",
    mutation: organisationBootstrapMutation(owner, NOW),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: NOW,
  });
  await seedReadyOnboarding(db, organisation.organisationId, owner.userId);
  await armOnboardingActivationAcceptanceFault(storage, {
    requestId: newRequestId(),
    phase: "placement",
    armedAt: NOW + 1,
  });

  const started = await beginOnboardingActivation({
    db,
    fence: await activationFence(db, organisation.organisationId),
    request: activationRequest(
      organisation.organisationId,
      owner.userId,
      "activate-interrupted-0001",
      NOW + 2,
    ),
  });
  expect(started.ok).toBe(true);
  if (!started.ok || started.value.kind !== "run") {
    throw new Error("interrupted activation did not start");
  }
  const initialContext = started.value.context;
  await checkpointActivationStep({
    db,
    context: initialContext,
    step: "readiness",
    receipt: { readinessHash: initialContext.readinessHash },
    now: NOW + 3,
  });
  await checkpointActivationStep({
    db,
    context: initialContext,
    step: "placement",
    receipt: { placement: "ready" },
    now: NOW + 4,
  });
  const interruption = await consumeOnboardingActivationAcceptanceFault(
    storage,
    NOW + 5,
  );
  if (!interruption.ok || interruption.value.kind !== "consumed") {
    throw new Error("armed activation interruption was not consumed");
  }
  await failOnboardingActivation({
    db,
    context: initialContext,
    failureCode: "activation_interrupted",
    retryable: true,
    now: NOW + 6,
  });

  await expect(
    readActivationEvidence(db, organisation.organisationId),
  ).resolves.toEqual({
    lifecycle: "configuring",
    activationAttemptId: null,
    activationReceiptId: null,
    attemptStatus: "failed",
    failureCode: "activation_interrupted",
    retryable: 1,
    receiptCount: 0,
  });

  const resumed = await beginOnboardingActivation({
    db,
    fence: await activationFence(db, organisation.organisationId),
    request: activationRequest(
      organisation.organisationId,
      owner.userId,
      "activate-interrupted-0002",
      NOW + 7,
    ),
  });
  expect(resumed.ok).toBe(true);
  if (!resumed.ok || resumed.value.kind !== "run") {
    throw new Error("interrupted activation did not resume");
  }
  expect(resumed.value.context.attemptId).toBe(initialContext.attemptId);
  expect([...resumed.value.context.completedSteps].sort()).toEqual([
    "placement",
    "readiness",
  ]);
  await expect(
    consumeOnboardingActivationAcceptanceFault(storage, NOW + 8),
  ).resolves.toEqual({ ok: true, value: { kind: "inactive" } });

  await checkpointRemainingActivationSteps(db, resumed.value.context, NOW + 9);
  const receipt = await completeOnboardingActivation({
    db,
    context: resumed.value.context,
    now: NOW + 13,
  });
  await expect(
    readActivationEvidence(db, organisation.organisationId),
  ).resolves.toEqual({
    lifecycle: "active",
    activationAttemptId: null,
    activationReceiptId: receipt.activationReceiptId,
    attemptStatus: "completed",
    failureCode: null,
    retryable: null,
    receiptCount: 1,
  });
  await expect(
    inspectOnboardingActivationAcceptanceFault(storage),
  ).resolves.toEqual({
    ok: true,
    value: {
      kind: "present",
      fault: expect.objectContaining({ state: "consumed", phase: "placement" }),
    },
  });
}

async function checkpointRemainingActivationSteps(
  db: SingleDatabase,
  context: ActivationContext,
  now: number,
): Promise<void> {
  await checkpointActivationStep({
    db,
    context,
    step: "policy",
    receipt: { policy: "active" },
    now,
  });
  await checkpointActivationStep({
    db,
    context,
    step: "cues",
    receipt: { cues: "active" },
    now: now + 1,
  });
  await checkpointActivationStep({
    db,
    context,
    step: "accounts",
    receipt: { accounts: "active" },
    now: now + 2,
  });
  await checkpointActivationStep({
    db,
    context,
    step: "publish",
    receipt: { activationReadyToFinalize: true },
    now: now + 3,
  });
}

async function readActivationEvidence(
  db: SingleDatabase,
  organisationId: OrganisationId,
): Promise<{
  lifecycle: string;
  activationAttemptId: string | null;
  activationReceiptId: string | null;
  attemptStatus: string;
  failureCode: string | null;
  retryable: number | null;
  receiptCount: number;
}> {
  const row = await db
    .prepare(
      `SELECT onboarding.lifecycle,
            onboarding.activation_attempt_id AS activationAttemptId,
            onboarding.activation_receipt_id AS activationReceiptId,
            attempt.status AS attemptStatus,
            attempt.failure_code AS failureCode,
            attempt.retryable,
            (SELECT COUNT(*) FROM organisation_activation_receipt AS receipt
             WHERE receipt.organisation_id = onboarding.organisation_id) AS receiptCount
     FROM organisation_onboarding AS onboarding
     JOIN organisation_activation_attempt AS attempt
       ON attempt.organisation_id = onboarding.organisation_id
     WHERE onboarding.organisation_id = ?`,
    )
    .bind(organisationId)
    .first<{
      lifecycle: string;
      activationAttemptId: string | null;
      activationReceiptId: string | null;
      attemptStatus: string;
      failureCode: string | null;
      retryable: number | null;
      receiptCount: number;
    }>();
  if (row === null) {
    throw new Error("activation evidence missing");
  }
  return row;
}

class MemoryActivationFaultStorage implements OnboardingActivationAcceptanceFaultStorage {
  readonly values = new Map<string, unknown>();

  async get(key: string): Promise<unknown | undefined> {
    return this.values.get(key);
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }
}

function setupMutation(
  organisationId: OrganisationId,
  userId: UserId,
  idempotencyKey: string,
  now: number,
) {
  return {
    boundary: {
      kind: "configuration_versioned" as const,
      idempotencyKey,
      requestHash: "setup-request-hash",
      expectedConfigurationVersion: 1,
    },
    scope: {
      userId,
      organisationScope: organisationId,
      route: `/v1/control/organisations/${organisationId}/setup`,
      operation: "setup.save",
    },
    identity: newControlMutationIdentity({
      portalSubjectHash: "activation-test-subject",
      causationId: `setup-test-${now}`,
      now,
    }),
  };
}

async function readSlackCredentialEvidence(
  db: SingleDatabase,
  organisationId: OrganisationId,
): Promise<{
  readonly credentialGeneration: number;
  readonly credentialRef: string;
  readonly generationCount: number;
  readonly activeGenerationCount: number;
}> {
  const row = await db
    .prepare(
      `SELECT connection.credential_generation AS credentialGeneration,
            connection.credential_ref AS credentialRef,
            (SELECT COUNT(*) FROM provider_credential_generation AS generation
             WHERE generation.provider_connection_id = connection.provider_connection_id)
              AS generationCount,
            (SELECT COUNT(*) FROM provider_credential_generation AS generation
             WHERE generation.provider_connection_id = connection.provider_connection_id
               AND generation.lifecycle = 'active') AS activeGenerationCount
     FROM provider_connection AS connection
     WHERE connection.organisation_id = ?
       AND connection.provider_connection_id = 'activation_slack_connection'`,
    )
    .bind(organisationId)
    .first<{
      readonly credentialGeneration: unknown;
      readonly credentialRef: unknown;
      readonly generationCount: unknown;
      readonly activeGenerationCount: unknown;
    }>();
  if (
    row === null ||
    typeof row.credentialGeneration !== "number" ||
    typeof row.credentialRef !== "string" ||
    typeof row.generationCount !== "number" ||
    typeof row.activeGenerationCount !== "number"
  ) {
    throw new Error("Slack credential replay evidence is invalid");
  }
  return {
    credentialGeneration: row.credentialGeneration,
    credentialRef: row.credentialRef,
    generationCount: row.generationCount,
    activeGenerationCount: row.activeGenerationCount,
  };
}

async function readSetupReplayEvidence(
  db: SingleDatabase,
  organisationId: OrganisationId,
): Promise<{
  readonly configurationVersion: number;
  readonly destinationCount: number;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly receiptCount: number;
}> {
  const row = await db
    .prepare(
      `SELECT onboarding.configuration_version AS configurationVersion,
            destination.workspace_id AS workspaceId,
            destination.channel_id AS channelId,
            (SELECT COUNT(*) FROM organisation_communication_destination AS counted
             WHERE counted.organisation_id = onboarding.organisation_id) AS destinationCount,
            (SELECT COUNT(*) FROM control_mutation_receipt AS receipt
             WHERE receipt.organisation_scope = onboarding.organisation_id
               AND receipt.operation = 'setup.save') AS receiptCount
     FROM organisation_onboarding AS onboarding
     JOIN organisation_communication_destination AS destination
       ON destination.organisation_id = onboarding.organisation_id
     WHERE onboarding.organisation_id = ?`,
    )
    .bind(organisationId)
    .first<{
      readonly configurationVersion: unknown;
      readonly destinationCount: unknown;
      readonly workspaceId: unknown;
      readonly channelId: unknown;
      readonly receiptCount: unknown;
    }>();
  if (
    row === null ||
    typeof row.configurationVersion !== "number" ||
    typeof row.destinationCount !== "number" ||
    typeof row.workspaceId !== "string" ||
    typeof row.channelId !== "string" ||
    typeof row.receiptCount !== "number"
  ) {
    throw new Error("setup replay evidence is invalid");
  }
  return {
    configurationVersion: row.configurationVersion,
    destinationCount: row.destinationCount,
    workspaceId: row.workspaceId,
    channelId: row.channelId,
    receiptCount: row.receiptCount,
  };
}

function activationRequest(
  organisationId: OrganisationId,
  userId: UserId,
  idempotencyKey: string,
  now: number,
) {
  return {
    organisationId,
    readinessVersion: 1,
    readinessHash: "readiness-hash-1",
    mutation: {
      boundary: {
        kind: "configuration_versioned" as const,
        idempotencyKey,
        requestHash: "activation-request-hash",
        expectedConfigurationVersion: 1,
      },
      scope: {
        userId,
        organisationScope: organisationId,
        route: `/v1/control/organisations/${organisationId}/activate`,
        operation: "organisation.activation.start",
      },
      identity: newControlMutationIdentity({
        portalSubjectHash: "activation-test-subject",
        causationId: `activation-test-${now}`,
        now,
      }),
    },
    now,
  };
}

async function readStaleReadinessEvidence(
  db: SingleDatabase,
  organisationId: OrganisationId,
): Promise<{
  lifecycle: string;
  configurationVersion: number;
  readinessVersion: number | null;
  activationAttemptId: string | null;
  activationReceiptId: string | null;
  attemptCount: number;
  receiptCount: number;
}> {
  const row = await db
    .prepare(
      `SELECT lifecycle, configuration_version AS configurationVersion,
            readiness_version AS readinessVersion,
            activation_attempt_id AS activationAttemptId,
            activation_receipt_id AS activationReceiptId,
            (SELECT COUNT(*) FROM organisation_activation_attempt AS attempt
             WHERE attempt.organisation_id = onboarding.organisation_id) AS attemptCount,
            (SELECT COUNT(*) FROM organisation_activation_receipt AS receipt
             WHERE receipt.organisation_id = onboarding.organisation_id) AS receiptCount
     FROM organisation_onboarding AS onboarding
     WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<{
      lifecycle: string;
      configurationVersion: number;
      readinessVersion: number | null;
      activationAttemptId: string | null;
      activationReceiptId: string | null;
      attemptCount: number;
      receiptCount: number;
    }>();
  if (row === null) {
    throw new Error("stale readiness evidence is missing");
  }
  return row;
}

async function readDiagnosticReadSafetyEvidence(
  db: SingleDatabase,
  organisationId: OrganisationId,
): Promise<{
  lifecycle: string;
  configurationVersion: number;
  readinessVersion: number | null;
  readinessHash: string | null;
  activationAttemptId: string | null;
  activationReceiptId: string | null;
  attemptCount: number;
  receiptCount: number;
}> {
  const row = await db
    .prepare(
      `SELECT lifecycle, configuration_version AS configurationVersion,
            readiness_version AS readinessVersion,
            (SELECT assessment.readiness_hash
             FROM organisation_readiness_assessment AS assessment
             WHERE assessment.organisation_id = onboarding.organisation_id
             ORDER BY assessment.readiness_version DESC
             LIMIT 1) AS readinessHash,
            activation_attempt_id AS activationAttemptId,
            activation_receipt_id AS activationReceiptId,
            (SELECT COUNT(*) FROM organisation_activation_attempt AS attempt
             WHERE attempt.organisation_id = onboarding.organisation_id) AS attemptCount,
            (SELECT COUNT(*) FROM organisation_activation_receipt AS receipt
             WHERE receipt.organisation_id = onboarding.organisation_id) AS receiptCount
     FROM organisation_onboarding AS onboarding
     WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<{
      lifecycle: string;
      configurationVersion: number;
      readinessVersion: number | null;
      readinessHash: string | null;
      activationAttemptId: string | null;
      activationReceiptId: string | null;
      attemptCount: number;
      receiptCount: number;
    }>();
  if (row === null) {
    throw new Error("diagnostic read safety evidence is missing");
  }
  return row;
}

async function readReadProposeCapabilityEvidence(
  db: SingleDatabase,
  organisationId: OrganisationId,
): Promise<{
  capabilityProfile: string;
  highStakesWrites: string | null;
  enabledProviderWriteTools: number;
}> {
  const row = await db
    .prepare(
      `SELECT onboarding.capability_profile AS capabilityProfile,
            policy.body AS policyBody,
            (SELECT COUNT(*) FROM organisation_capability_policy AS policy
             WHERE policy.organisation_id = onboarding.organisation_id
               AND policy.mode <> 'disabled'
               AND (policy.capability_id LIKE 'stripe.%'
                OR policy.capability_id LIKE 'shopify.%')) AS enabledProviderWriteTools
     FROM organisation_onboarding AS onboarding
     JOIN organisation_setup_snapshot AS policy
       ON policy.organisation_id = onboarding.organisation_id
      AND policy.snapshot_kind = 'policy'
     WHERE onboarding.organisation_id = ?
     ORDER BY policy.created_at DESC
     LIMIT 1`,
    )
    .bind(organisationId)
    .first<{
      capabilityProfile: unknown;
      policyBody: unknown;
      enabledProviderWriteTools: unknown;
    }>();
  if (
    row === null ||
    typeof row.capabilityProfile !== "string" ||
    typeof row.policyBody !== "string" ||
    typeof row.enabledProviderWriteTools !== "number"
  ) {
    throw new Error("read_and_propose capability evidence is missing");
  }
  const policyBody: unknown = JSON.parse(row.policyBody);
  return {
    capabilityProfile: row.capabilityProfile,
    highStakesWrites:
      isRecord(policyBody) && typeof policyBody.highStakesWrites === "string"
        ? policyBody.highStakesWrites
        : null,
    enabledProviderWriteTools: row.enabledProviderWriteTools,
  };
}

async function seedReadyOnboarding(
  db: SingleDatabase,
  organisationId: string,
  userId: string,
): Promise<void> {
  const session = db.withSession("first-primary");
  await session.batch([
    session
      .prepare(
        `INSERT INTO organisation_setup_snapshot (
         organisation_id, snapshot_kind, snapshot_id, template_id, template_version,
         body, selected_by_user_id, created_at
       ) VALUES (?, 'policy', 'setup_snapshot_policy', 'commerce_operator', 1,
         '{"templateId":"commerce_operator","version":1,"capabilityProfile":"read_and_propose","outputScreeningMode":"stream","highStakesWrites":"disabled"}', ?, ?)`,
      )
      .bind(organisationId, userId, NOW),
    session
      .prepare(
        `INSERT INTO organisation_setup_snapshot (
         organisation_id, snapshot_kind, snapshot_id, template_id, template_version,
         body, selected_by_user_id, created_at
       ) VALUES (?, 'cue', 'setup_snapshot_cue', 'observe_commerce', 1, '{}', ?, ?)`,
      )
      .bind(organisationId, userId, NOW),
    session
      .prepare(
        `INSERT INTO organisation_onboarding_selection (
         organisation_id, policy_template_id, policy_template_version, cue_preset_id,
         cue_preset_version, cue_workspace_id, cue_channel_id,
         selected_by_user_id, selected_at
       ) VALUES (?, 'commerce_operator', 1, 'observe_commerce', 1, NULL, NULL, ?, ?)`,
      )
      .bind(organisationId, userId, NOW),
    session
      .prepare(
        `INSERT INTO provider_connection (
         provider_connection_id, organisation_id, provider, auth_mode, authority_kind, credential_generation,
         credential_ref, lifecycle, granted_scopes, created_by_user_id,
         created_at, updated_at, disabled_at, revoked_at, environment, provider_subject_id
       ) VALUES
         ('activation_slack_connection', ?, 'slack', 'shared_pantry_app', 'connection_credential', 1,
          'vault:activation:slack', 'active', '[]', ?, ?, ?, NULL, NULL,
          'development', 'activation-workspace'),
         ('activation_shop_connection', ?, 'shopify', 'shared_pantry_app', 'connection_credential', 1,
          'vault:activation:shopify', 'active', '[]', ?, ?, ?, NULL, NULL,
          'development', 'activation-shop')`,
      )
      .bind(organisationId, userId, NOW, NOW, organisationId, userId, NOW, NOW),
    session
      .prepare(
        `INSERT INTO integration_account (
         integration_account_id, organisation_id, provider_connection_id, provider,
         provider_account_id, account_kind, display_name, lifecycle,
         lifecycle_reason_code, capability_set, audience_policy, retention_policy,
         created_at, updated_at, disabled_by_user_id, disabled_at,
         revoked_at, environment, is_default_for_provider
       ) VALUES
         ('activation_slack_account', ?, 'activation_slack_connection', 'slack',
          'activation-workspace', 'workspace', 'Activation workspace', 'active',
          NULL, '[]', '{"kind":"operator"}', '{"kind":"organisation_default"}',
          ?, ?, NULL, NULL, NULL, 'development', 1),
         ('activation_shop_account', ?, 'activation_shop_connection', 'shopify',
          'activation-shop', 'store', 'Activation shop', 'active',
          NULL, '[]', '{"kind":"operator"}', '{"kind":"organisation_default"}',
          ?, ?, NULL, NULL, NULL, 'development', 1)`,
      )
      .bind(organisationId, NOW, NOW, organisationId, NOW, NOW),
    session
      .prepare(
        `INSERT INTO surface_installation (
         integration_account_id, organisation_id, surface_kind, workspace_id,
         install_model, bot_token_ref, scopes, installed_at, last_event_received_at
       ) VALUES (
         'activation_slack_account', ?, 'slack', 'activation-workspace',
         'unlisted', 'vault:activation:slack', '[]', ?, NULL
       )`,
      )
      .bind(organisationId, NOW),
    session
      .prepare(
        `INSERT INTO commerce_merchant_binding (
         binding_id, organisation_id, integration_account_id, merchant_id, environment,
         delivery_signing_key_id, delivery_signing_public_key_b64,
         revision, created_at, updated_at
       ) VALUES (
         'commerce_binding_activation', ?, 'integration_commerce_activation',
         'merchant_activation', 'development', 'key_commerce_activation',
         'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 1, ?, ?
       )`,
      )
      .bind(organisationId, NOW, NOW),
    session
      .prepare(
        `INSERT INTO organisation_commerce_system (
         organisation_id, system_kind, commerce_binding_id,
         shopify_integration_account_id, revision, selected_at,
         selected_by_user_id
       ) VALUES (?, 'shopify', NULL, 'activation_shop_account', 1, ?, ?)`,
      )
      .bind(organisationId, NOW, userId),
    session
      .prepare(
        `INSERT INTO provider_resource_snapshot (
         snapshot_revision, organisation_id, integration_account_id, provider,
         environment, query_hash, created_at
       ) VALUES (
         'activation-resource-snapshot', ?, 'activation_slack_account',
         'slack', 'development', 'all-channels', ?
       )`,
      )
      .bind(organisationId, NOW),
    session.prepare(
      `INSERT INTO provider_discovered_resource (
         snapshot_revision, canonical_resource_id, provider_resource_id,
         provider_account_id, display_label, access_state,
         provider_revision, resource_kind
       ) VALUES (
         'activation-resource-snapshot', 'activation-channel',
         'activation-channel', 'activation-workspace', 'Activation channel',
         'accessible', 'channel-revision-1', 'channel'
       )`,
    ),
    session
      .prepare(
        `INSERT INTO organisation_communication_destination (
         organisation_id, integration_account_id, workspace_id, channel_id,
         provider_revision, selected_at
       ) VALUES (
         ?, 'activation_slack_account', 'activation-workspace',
         'activation-channel', 'channel-revision-1', ?
       )`,
      )
      .bind(organisationId, NOW),
    session
      .prepare(
        `INSERT INTO organisation_readiness_assessment (
         organisation_id, readiness_version, readiness_hash, configuration_version, capability_profile,
         policy_snapshot_id, cue_snapshot_id, blockers, assessed_at, environment
       ) VALUES (?, 1, 'readiness-hash-1', 1, 'read_and_propose',
         'setup_snapshot_policy', 'setup_snapshot_cue', '[]', ?, 'development')`,
      )
      .bind(organisationId, NOW),
  ]);
}

async function replaceShopifyWithPantryCommerce(
  db: SingleDatabase,
  organisationId: string,
  userId: string,
): Promise<void> {
  const session = db.withSession("first-primary");
  await session.batch([
    session
      .prepare(
        "DELETE FROM organisation_commerce_system WHERE organisation_id = ?",
      )
      .bind(organisationId),
    session
      .prepare(
        "DELETE FROM integration_account WHERE organisation_id = ? AND provider = 'shopify'",
      )
      .bind(organisationId),
    session
      .prepare(
        "DELETE FROM provider_connection WHERE organisation_id = ? AND provider = 'shopify'",
      )
      .bind(organisationId),
    session
      .prepare(
        `INSERT INTO organisation_commerce_system (
         organisation_id, system_kind, commerce_binding_id,
         shopify_integration_account_id, revision, selected_at,
         selected_by_user_id
       ) VALUES (?, 'builtin_commerce', 'commerce_binding_activation', NULL, 1, ?, ?)`,
      )
      .bind(organisationId, NOW, userId),
  ]);
}

async function readPantryCommerceActivationEvidence(
  db: SingleDatabase,
  organisationId: OrganisationId,
): Promise<
  Readonly<{
    lifecycle: string;
    systemKind: string;
    commerceSystemRevision: number;
    destinationId: string;
    shopifyAccounts: number;
    stripeAccounts: number;
    slackAccounts: number;
  }>
> {
  const row = await db
    .prepare(
      `SELECT onboarding.lifecycle,
            system.system_kind AS systemKind,
            task.commerce_system_revision AS commerceSystemRevision,
            task.destination_id AS destinationId,
            (SELECT COUNT(*) FROM integration_account
             WHERE organisation_id = onboarding.organisation_id AND provider = 'shopify') AS shopifyAccounts,
            (SELECT COUNT(*) FROM integration_account
             WHERE organisation_id = onboarding.organisation_id AND provider = 'stripe') AS stripeAccounts,
            (SELECT COUNT(*) FROM integration_account
             WHERE organisation_id = onboarding.organisation_id AND provider = 'slack') AS slackAccounts
     FROM organisation_onboarding AS onboarding
     JOIN organisation_commerce_system AS system ON system.organisation_id = onboarding.organisation_id
     JOIN organisation_first_operational_task AS task ON task.organisation_id = onboarding.organisation_id
     WHERE onboarding.organisation_id = ?`,
    )
    .bind(organisationId)
    .first<{
      lifecycle: string;
      systemKind: string;
      commerceSystemRevision: number;
      destinationId: string;
      shopifyAccounts: number;
      stripeAccounts: number;
      slackAccounts: number;
    }>();
  if (row === null)
    throw new Error("Seams Checkout activation evidence is missing");
  return row;
}

async function seedReadyApprovedProviderWritesOnboarding(
  db: SingleDatabase,
  organisationId: string,
  userId: string,
): Promise<void> {
  await seedReadyOnboarding(db, organisationId, userId);
  const session = db.withSession("first-primary");
  await session.batch([
    session
      .prepare(
        `UPDATE organisation_onboarding
       SET capability_profile = 'approved_provider_writes', updated_at = ?
       WHERE organisation_id = ?`,
      )
      .bind(NOW, organisationId),
    session
      .prepare(
        `UPDATE organisation_setup_snapshot
       SET body = ?
       WHERE organisation_id = ? AND snapshot_kind = 'policy'`,
      )
      .bind(
        JSON.stringify({
          templateId: "commerce_operator",
          version: 1,
          capabilityProfile: "approved_provider_writes",
          outputScreeningMode: "stream",
          highStakesWrites: "approval_required",
        }),
        organisationId,
      ),
    session
      .prepare(
        `INSERT INTO provider_credential_generation (
         provider_connection_id, credential_generation, organisation_id, provider,
         environment, credential_ref, lifecycle, created_at, activated_at,
         superseded_at, revoked_at, failed_at, failure_code
       ) VALUES
         ('activation_slack_connection', 1, ?, 'slack', 'development',
          'vault:activation:slack', 'active', ?, ?, NULL, NULL, NULL, NULL),
         ('activation_shop_connection', 1, ?, 'shopify', 'development',
          'vault:activation:shopify', 'active', ?, ?, NULL, NULL, NULL, NULL)`,
      )
      .bind(organisationId, NOW, NOW, organisationId, NOW, NOW),
    session
      .prepare(
        `INSERT INTO provider_manifest_observation (
         observation_id, organisation_id, integration_account_id, provider,
         environment, manifest_version, lifecycle, evidence_code, reason_code,
         missing_optional_capabilities, repair_actions, observed_at
       ) VALUES
         ('approved-writes-slack-manifest', ?, 'activation_slack_account', 'slack',
          'development', 1, 'healthy', 'provider_identity_verified', NULL, NULL, NULL, ?),
         ('approved-writes-shopify-manifest', ?, 'activation_shop_account', 'shopify',
          'development', 1, 'healthy', 'provider_webhook_verified', NULL, NULL, NULL, ?)`,
      )
      .bind(organisationId, NOW, organisationId, NOW),
    session
      .prepare(
        `INSERT INTO provider_webhook (
         provider_webhook_id, organisation_id, integration_account_id, provider,
         provider_native_id, event_type, lifecycle, lifecycle_reason_code,
         signing_secret_ref, credential_generation, last_verified_at, updated_at,
         environment
       ) VALUES (
         'approved-writes-shopify-webhook', ?, 'activation_shop_account', 'shopify',
         'approved-writes-shop', 'orders/create', 'live', NULL,
         'vault:activation:shopify:webhook', 1, ?, ?, 'development')`,
      )
      .bind(organisationId, NOW, NOW),
    session
      .prepare(
        `DELETE FROM organisation_readiness_assessment WHERE organisation_id = ?`,
      )
      .bind(organisationId),
  ]);
}

async function countOpenSupportReferences(
  db: SingleDatabase,
  organisationId: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS open FROM onboarding_support_reference
     WHERE organisation_id = ? AND resolved_at IS NULL`,
    )
    .bind(organisationId)
    .first<{ readonly open: unknown }>();
  return typeof row?.open === "number" ? row.open : 0;
}
