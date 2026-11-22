import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, URL as NodeUrl } from "node:url";

import { describe, expect, it } from "vitest";

import type { CredentialVaultBindings } from "../src/credential-vault/keyring";
import { resolveVaultHandle } from "../src/credential-vault/service";
import { listIntegrationAccounts } from "@purin-labs/connections/data/integration-account";
import { compileEffectiveGrantSet } from "../src/authorization/access-grants";
import {
  buildCustomConnectorWriteAuthority,
  buildCustomConnectorOperationRequest,
  resolveCustomConnectorWritePreview,
  resolveApprovedCustomConnectorWrite,
  resolveCustomConnectorDetail,
  approveCustomConnectorRevision,
  attachCustomConnectorCandidateCredential,
  authorizeCustomConnectorSetupCommit,
  cancelCustomConnectorSetup,
  commitExistingCustomConnectorAccount,
  commitNewCustomConnectorAccount,
  compileCustomConnectorReadCatalog,
  createCustomConnectorDraft,
  createCustomConnectorRevision,
  prepareCustomConnectorDraftDocument,
  startCustomConnectorSetup,
  testCustomConnectorCandidate,
  validateCustomConnectorRevision,
  type CustomConnectorIdentityTestExecutor,
  type CustomConnectorIdentityTestRequest,
  type CustomConnectorDefinitionDigest,
  type CustomConnectorId,
  type CustomConnectorRevision,
  type CustomConnectorSetupTarget,
  type ActiveCustomConnectorAccount,
  type JsonObject,
  type CustomConnectorOperation,
} from "../src/custom-connectors";
import { type OrganisationId } from "@purin-labs/kernel/ids";
import { type UserId } from "@purin-labs/control-api/ids";
import type { CustomConnectorWriteCatalogEntry } from "../src/custom-connectors/grants";
import { d1Database } from "./sqlite-d1";
import {
  requireUserId,
  requireOrganisationId,
  requireVaultHandle,
} from "./test-ids";
import { TestSecretsStoreSecret } from "./secrets-store";

const baselineSql = singleDatabaseSchema();

describe("custom connector candidate setup", function setupSuite() {
  it(
    "verifies and commits an EasyPost account with a Basic API key kept in the Vault",
    testEasyPostSetup,
  );
  it(
    "previews exact write fields from pinned authority and rejects tampered inputs",
    testWritePreview,
  );
  it("keeps candidate authority inside Vault and binds identity testing to the pinned revision", async function testsCandidate() {
    const database = new DatabaseSync(":memory:");
    database.exec(baselineSql);
    seedIdentity(database);
    const db = d1Database(database);
    const keys = testVaultBindings();
    const organisationId = requireOrganisationId("organisation_custom_setup");
    const adminId = requireUserId("user_0f925c19-994a-51ec-99fd-76e584b4d4b0");
    const document = await prepareCustomConnectorDraftDocument(
      fixture("github-rest.json"),
    );
    if (!document.ok) throw new Error(document.error.code);
    const draft = await createCustomConnectorDraft({
      db,
      organisationId,
      createdByUserId: adminId,
      document: document.value,
      now: 100,
    });
    const validated = await validateCustomConnectorRevision({
      db,
      organisationId,
      connectorId: draft.connectorId,
      revision: draft.revision,
      authoringDigest: draft.authoringDigest,
      now: 110,
    });
    if (!validated.ok || validated.value.reviewState !== "validated") {
      throw new Error("fixture definition did not validate");
    }

    const started = await startCustomConnectorSetup({
      db,
      organisationId,
      connectorId: draft.connectorId,
      connectorRevision: draft.revision,
      definitionDigest: validated.value.definitionDigest,
      target: { kind: "new_account", environment: "development" },
      createdByUserId: adminId,
      now: 120,
    });
    expect(started).toMatchObject({
      ok: true,
      value: {
        lifecycle: "awaiting_credential",
        candidateGeneration: 0,
        attemptRevision: 1,
      },
    });
    if (!started.ok) return;

    const attached = await attachCustomConnectorCandidateCredential({
      db,
      keys,
      organisationId,
      attemptId: started.value.attemptId,
      expectedAttemptRevision: started.value.attemptRevision,
      credentialValue: "candidate-secret-value",
      now: 130,
    });
    expect(attached).toMatchObject({
      ok: true,
      value: {
        lifecycle: "credential_stored",
        candidateGeneration: 1,
        attemptRevision: 2,
      },
    });
    expect(JSON.stringify(attached)).not.toContain("candidate-secret-value");
    expect(JSON.stringify(attached)).not.toContain("vault:");
    if (!attached.ok) return;

    const tested = await testCustomConnectorCandidate({
      db,
      keys,
      organisationId,
      attemptId: attached.value.attemptId,
      expectedAttemptRevision: attached.value.attemptRevision,
      executor: successfulIdentityTest,
      now: 140,
    });
    expect(tested).toMatchObject({
      ok: true,
      value: {
        attempt: {
          lifecycle: "verified",
          attemptRevision: 4,
          definitionDigest: validated.value.definitionDigest,
          verification: {
            providerAccountId: "octocat",
            displayName: "The Octocat",
            testedAt: 140,
          },
        },
        preview: { login: "octocat" },
      },
    });
    expect(JSON.stringify(tested)).not.toContain("candidate-secret-value");
    if (!tested.ok) return;

    const cancelled = await cancelCustomConnectorSetup({
      db,
      organisationId,
      attemptId: tested.value.attempt.attemptId,
      expectedAttemptRevision: tested.value.attempt.attemptRevision,
      cancelledByUserId: adminId,
      now: 150,
    });
    expect(cancelled).toMatchObject({
      ok: true,
      value: { lifecycle: "cancelled", attemptRevision: 5 },
    });

    const credentialRow = database
      .prepare(
        `SELECT candidate_credential_ref AS candidateCredentialRef
         FROM custom_connector_setup_attempt WHERE organisation_id = ? AND attempt_id = ?`,
      )
      .get(organisationId, started.value.attemptId);
    if (
      credentialRow === undefined ||
      typeof credentialRow.candidateCredentialRef !== "string"
    ) {
      throw new Error("candidate credential reference is missing");
    }
    const handle = requireVaultHandle(credentialRow.candidateCredentialRef);
    const resolved = await resolveVaultHandle({
      db,
      keys,
      organisationId,
      handle,
    });
    expect(resolved).toMatchObject({
      ok: false,
      error: { code: "vault_secret_revoked" },
    });
    database.close();
  });

  it("atomically promotes a verified candidate into a connector-scoped account", async function commitsCandidate() {
    const database = new DatabaseSync(":memory:");
    database.exec(baselineSql);
    seedIdentity(database);
    const db = d1Database(database);
    const keys = testVaultBindings();
    const organisationId = requireOrganisationId("organisation_custom_setup");
    const adminId = requireUserId("user_0f925c19-994a-51ec-99fd-76e584b4d4b0");
    const document = await prepareCustomConnectorDraftDocument(
      fixture("github-rest.json"),
    );
    if (!document.ok) throw new Error(document.error.code);
    const draft = await createCustomConnectorDraft({
      db,
      organisationId,
      createdByUserId: adminId,
      document: document.value,
      now: 200,
    });
    const validated = await validateCustomConnectorRevision({
      db,
      organisationId,
      connectorId: draft.connectorId,
      revision: draft.revision,
      authoringDigest: draft.authoringDigest,
      now: 210,
    });
    if (!validated.ok || validated.value.reviewState !== "validated") {
      throw new Error("fixture definition did not validate");
    }
    const approved = await approveCustomConnectorRevision({
      db,
      organisationId,
      connectorId: draft.connectorId,
      revision: draft.revision,
      definitionDigest: validated.value.definitionDigest,
      approvedByUserId: adminId,
      review: {
        origin: validated.value.definition.origin,
        effects: approvalEffects(validated.value.definition.operations),
      },
      now: 220,
    });
    if (!approved.ok || approved.value.reviewState !== "approved") {
      throw new Error("fixture definition did not approve");
    }
    const started = await startCustomConnectorSetup({
      db,
      organisationId,
      connectorId: draft.connectorId,
      connectorRevision: draft.revision,
      definitionDigest: approved.value.definitionDigest,
      target: { kind: "new_account", environment: "development" },
      createdByUserId: adminId,
      now: 230,
    });
    if (!started.ok) throw new Error(started.error.code);
    const attached = await attachCustomConnectorCandidateCredential({
      db,
      keys,
      organisationId,
      attemptId: started.value.attemptId,
      expectedAttemptRevision: started.value.attemptRevision,
      credentialValue: "candidate-secret-value",
      now: 240,
    });
    if (!attached.ok) throw new Error(attached.error.code);
    const tested = await testCustomConnectorCandidate({
      db,
      keys,
      organisationId,
      attemptId: attached.value.attemptId,
      expectedAttemptRevision: attached.value.attemptRevision,
      executor: successfulIdentityTest,
      now: 250,
    });
    if (!tested.ok) throw new Error(tested.error.code);
    const authorization = await authorizeCustomConnectorSetupCommit({
      db,
      keys,
      organisationId,
      attemptId: tested.value.attempt.attemptId,
      expectedAttemptRevision: tested.value.attempt.attemptRevision,
      now: 260,
    });
    if (!authorization.ok) throw new Error(authorization.error.code);
    const committed = await commitNewCustomConnectorAccount({
      db,
      authorization: authorization.value,
      committedByUserId: adminId,
      expectedConfigurationVersion: 1,
      now: 270,
    });
    expect(committed).toMatchObject({
      ok: true,
      value: {
        source: { kind: "custom_api", connectorId: draft.connectorId },
        environment: "development",
        providerAccountId: "octocat",
        displayName: "The Octocat",
        lifecycle: { kind: "active" },
        binding: {
          lifecycle: "active",
          acceptedRevision: draft.revision,
          definitionDigest: approved.value.definitionDigest,
          bindingRevision: 1,
          credentialGeneration: 1,
          isDefaultForConnector: true,
        },
      },
    });
    expect(
      database
        .prepare(
          `SELECT lifecycle FROM custom_connector_setup_attempt
           WHERE organisation_id = ? AND attempt_id = ?`,
        )
        .get(organisationId, started.value.attemptId),
    ).toEqual({ lifecycle: "committed" });
    expect(
      database
        .prepare(
          `SELECT configuration_version AS configurationVersion,
                  projection_revision AS projectionRevision
           FROM organisation_onboarding WHERE organisation_id = ?`,
        )
        .get(organisationId),
    ).toEqual({ configurationVersion: 2, projectionRevision: 2 });
    await expect(
      listIntegrationAccounts({ db, organisationId }),
    ).resolves.toEqual([]);
    if (!committed.ok) throw new Error(committed.error.code);
    database
      .prepare(
        "UPDATE organisation_onboarding SET lifecycle = 'active', activation_receipt_id = 'receipt_custom_read', activated_at = 280 WHERE organisation_id = ?",
      )
      .run(organisationId);
    const grantTarget = {
      kind: "custom_connector_operation" as const,
      capabilityId: "custom_connector.read",
      capabilityVersion: 1,
      integrationAccountId: committed.value.integrationAccountId,
      connectorId: draft.connectorId,
      definitionRevision: draft.revision,
      definitionDigest: approved.value.definitionDigest,
      operationId: "current_user",
    };
    const effective = compileEffectiveGrantSet({
      organisationId,
      authority: {
        kind: "control",
        organisationId,
        requesterPersonId: "person_custom_setup",
        userId: adminId,
        membershipRevision: 2,
        role: "admin",
      },
      grants: [
        {
          grantId: "grant_custom_current_user",
          organisationId,
          subject: { kind: "organisation_role", role: "admin" },
          target: grantTarget,
          provenance: {
            kind: "operator",
            userId: adminId,
            mutationReceiptId: "mutation_custom_current_user",
          },
          lifecycle: { kind: "active", revision: 1, activatedAt: 280 },
        },
      ],
      organisationAllowedTools: ["custom_connector.read"],
    });
    if (!effective.ok) throw new Error(effective.error.code);
    database
      .prepare(
        `INSERT INTO access_grant (
           organisation_id, grant_id, subject_json, target_json, lifecycle,
           revision, reason, provenance_json, changed_at
         ) VALUES (?, 'grant_custom_current_user', ?, ?, 'active', 1, NULL, ?, 280)`,
      )
      .run(
        organisationId,
        JSON.stringify({ kind: "organisation_role", role: "admin" }),
        JSON.stringify(grantTarget),
        JSON.stringify({
          kind: "operator",
          userId: adminId,
          mutationReceiptId: "mutation_custom_current_user",
        }),
      );
    const catalog = await compileCustomConnectorReadCatalog({
      db,
      effectiveGrants: effective.value,
    });
    expect(catalog).toMatchObject({
      ok: true,
      value: [
        {
          description: "Read the authenticated GitHub user.",
          operation: { id: "current_user", effect: { kind: "read" } },
          grantIds: ["grant_custom_current_user"],
          grantRevisions: [1],
          bindingRevision: 1,
          credentialGeneration: 1,
        },
      ],
    });
    if (!catalog.ok) throw new Error(catalog.error.code);
    expect(catalog.value[0]?.toolName).toMatch(/^cc_[0-9a-f]{60}$/u);
    const entry = catalog.value[0];
    if (entry === undefined) throw new Error("custom catalog is empty");
    database
      .prepare(
        "UPDATE vault_secret SET revoked_at = 290 WHERE organisation_id = ?",
      )
      .run(organisationId);
    await expect(
      compileCustomConnectorReadCatalog({
        db,
        effectiveGrants: effective.value,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "custom_connector_catalog_entry_unavailable" },
    });
    database.close();
  });

  it("rotates, upgrades, and resumes an exact account while revoking superseded keys", async function updatesExistingAccount() {
    const database = new DatabaseSync(":memory:");
    database.exec(baselineSql);
    seedIdentity(database);
    const db = d1Database(database);
    const keys = testVaultBindings();
    const organisationId = requireOrganisationId("organisation_custom_setup");
    const adminId = requireUserId("user_0f925c19-994a-51ec-99fd-76e584b4d4b0");
    const initial = await createCommittedFixtureAccount({
      db,
      keys,
      organisationId,
      adminId,
    });
    const initialCredentialRef = readActiveCredentialRef(
      database,
      initial.account.providerConnectionId,
    );
    const queuedGrant = compileEffectiveGrantSet({
      organisationId,
      authority: {
        kind: "control",
        organisationId,
        requesterPersonId: "person_custom_setup",
        userId: adminId,
        membershipRevision: 1,
        role: "admin",
      },
      grants: [
        {
          grantId: "grant_custom_rotation_fence",
          organisationId,
          subject: { kind: "organisation_role", role: "admin" },
          target: {
            kind: "custom_connector_operation",
            capabilityId: "custom_connector.read",
            capabilityVersion: 1,
            integrationAccountId: initial.account.integrationAccountId,
            connectorId: initial.connectorId,
            definitionRevision: initial.revision,
            definitionDigest: initial.definitionDigest,
            operationId: "current_user",
          },
          provenance: {
            kind: "operator",
            userId: adminId,
            mutationReceiptId: "mutation_custom_rotation_fence",
          },
          lifecycle: { kind: "active", revision: 1, activatedAt: 1_080 },
        },
      ],
      organisationAllowedTools: ["custom_connector.read"],
    });
    if (!queuedGrant.ok) throw new Error(queuedGrant.error.code);
    persistCustomReadGrant(database, organisationId, initial, adminId);
    const queuedCatalog = await compileCustomConnectorReadCatalog({
      db,
      effectiveGrants: queuedGrant.value,
    });
    if (!queuedCatalog.ok || queuedCatalog.value[0] === undefined) {
      throw new Error("queued custom connector catalog is unavailable");
    }

    const mismatched = await startCustomConnectorSetup({
      db,
      organisationId,
      connectorId: initial.connectorId,
      connectorRevision: initial.revision,
      definitionDigest: initial.definitionDigest,
      target: {
        kind: "rotate_account",
        integrationAccountId: initial.account.integrationAccountId,
        expectedBindingRevision: 1,
      },
      createdByUserId: adminId,
      now: 1_100,
    });
    if (!mismatched.ok) throw new Error(mismatched.error.code);
    const mismatchedCredential = await attachCustomConnectorCandidateCredential(
      {
        db,
        keys,
        organisationId,
        attemptId: mismatched.value.attemptId,
        expectedAttemptRevision: mismatched.value.attemptRevision,
        credentialValue: "wrong-identity-secret",
        now: 1_110,
      },
    );
    if (!mismatchedCredential.ok) {
      throw new Error(mismatchedCredential.error.code);
    }
    const mismatchedCredentialRef = readSetupCredentialRef(
      database,
      mismatchedCredential.value.attemptId,
    );
    await expect(
      testCustomConnectorCandidate({
        db,
        keys,
        organisationId,
        attemptId: mismatchedCredential.value.attemptId,
        expectedAttemptRevision: mismatchedCredential.value.attemptRevision,
        executor: mismatchedIdentityTest,
        now: 1_120,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "custom_connector_account_identity_mismatch" },
    });
    expect(
      readActiveCredentialGeneration(
        database,
        initial.account.providerConnectionId,
      ),
    ).toBe(1);
    expect(readVaultRevokedAt(database, mismatchedCredentialRef)).toBe(1_120);

    const rotated = await commitExistingFixtureSetup({
      db,
      keys,
      organisationId,
      adminId,
      connectorId: initial.connectorId,
      connectorRevision: initial.revision,
      definitionDigest: initial.definitionDigest,
      target: {
        kind: "rotate_account",
        integrationAccountId: initial.account.integrationAccountId,
        expectedBindingRevision: 1,
      },
      credentialValue: "rotated-secret",
      executor: rotatedIdentityTest,
      expectedConfigurationVersion: 2,
      now: 1_200,
    });
    expect(rotated.binding).toMatchObject({
      bindingRevision: 2,
      credentialGeneration: 2,
      acceptedRevision: initial.revision,
    });
    expect(readVaultRevokedAt(database, initialCredentialRef)).toBe(1_230);
    expect(
      readCredentialGenerationLifecycle(
        database,
        rotated.providerConnectionId,
        1,
      ),
    ).toBe("superseded");
    const revisedDocument = await prepareCustomConnectorDraftDocument({
      ...fixture("github-rest.json"),
      description: "Read GitHub identity through revision two.",
    });
    if (!revisedDocument.ok) throw new Error(revisedDocument.error.code);
    const revisedDraft = await createCustomConnectorRevision({
      db,
      organisationId,
      connectorId: initial.connectorId,
      expectedHeadRevision: initial.revision,
      createdByUserId: adminId,
      document: revisedDocument.value,
      now: 1_300,
    });
    if (!revisedDraft.ok) throw new Error(revisedDraft.error.code);
    const revisedValidated = await validateCustomConnectorRevision({
      db,
      organisationId,
      connectorId: initial.connectorId,
      revision: revisedDraft.value.revision,
      authoringDigest: revisedDraft.value.authoringDigest,
      now: 1_310,
    });
    if (
      !revisedValidated.ok ||
      revisedValidated.value.reviewState !== "validated"
    ) {
      throw new Error("revised fixture did not validate");
    }
    const revisedApproved = await approveCustomConnectorRevision({
      db,
      organisationId,
      connectorId: initial.connectorId,
      revision: revisedValidated.value.revision,
      definitionDigest: revisedValidated.value.definitionDigest,
      approvedByUserId: adminId,
      review: {
        origin: revisedValidated.value.definition.origin,
        effects: approvalEffects(revisedValidated.value.definition.operations),
      },
      now: 1_320,
    });
    if (
      !revisedApproved.ok ||
      revisedApproved.value.reviewState !== "approved"
    ) {
      throw new Error("revised fixture did not approve");
    }
    const rotatedCredentialRef = readActiveCredentialRef(
      database,
      rotated.providerConnectionId,
    );
    const upgraded = await commitExistingFixtureSetup({
      db,
      keys,
      organisationId,
      adminId,
      connectorId: initial.connectorId,
      connectorRevision: revisedApproved.value.revision,
      definitionDigest: revisedApproved.value.definitionDigest,
      target: {
        kind: "upgrade_account",
        integrationAccountId: initial.account.integrationAccountId,
        expectedBindingRevision: 2,
      },
      credentialValue: "upgraded-secret",
      executor: upgradedIdentityTest,
      expectedConfigurationVersion: 3,
      now: 1_400,
    });
    expect(upgraded.binding).toMatchObject({
      bindingRevision: 3,
      credentialGeneration: 3,
      acceptedRevision: revisedApproved.value.revision,
      definitionDigest: revisedApproved.value.definitionDigest,
    });
    expect(readVaultRevokedAt(database, rotatedCredentialRef)).toBe(1_430);

    database
      .prepare(
        `UPDATE integration_account
         SET lifecycle = 'disabled', disabled_by_user_id = ?,
             disabled_at = 1500, updated_at = 1500
         WHERE organisation_id = ? AND integration_account_id = ?`,
      )
      .run(adminId, organisationId, upgraded.integrationAccountId);
    database
      .prepare(
        `UPDATE provider_connection
         SET lifecycle = 'disabled', disabled_at = 1500, updated_at = 1500
         WHERE organisation_id = ? AND provider_connection_id = ?`,
      )
      .run(organisationId, upgraded.providerConnectionId);
    database
      .prepare(
        `UPDATE custom_connector_account_binding
         SET lifecycle = 'disabled', disabled_at = 1500, updated_at = 1500
         WHERE organisation_id = ? AND integration_account_id = ?`,
      )
      .run(organisationId, upgraded.integrationAccountId);
    const upgradedCredentialRef = readActiveCredentialRef(
      database,
      upgraded.providerConnectionId,
    );
    const resumed = await commitExistingFixtureSetup({
      db,
      keys,
      organisationId,
      adminId,
      connectorId: initial.connectorId,
      connectorRevision: revisedApproved.value.revision,
      definitionDigest: revisedApproved.value.definitionDigest,
      target: {
        kind: "resume_account",
        integrationAccountId: initial.account.integrationAccountId,
        expectedBindingRevision: 3,
      },
      credentialValue: "resumed-secret",
      executor: resumedIdentityTest,
      expectedConfigurationVersion: 4,
      now: 1_600,
    });
    expect(resumed).toMatchObject({
      lifecycle: { kind: "active" },
      binding: {
        lifecycle: "active",
        bindingRevision: 4,
        credentialGeneration: 4,
        acceptedRevision: revisedApproved.value.revision,
      },
    });
    expect(readVaultRevokedAt(database, upgradedCredentialRef)).toBe(1_630);
    await expect(
      startCustomConnectorSetup({
        db,
        organisationId,
        connectorId: initial.connectorId,
        connectorRevision: revisedApproved.value.revision,
        definitionDigest: revisedApproved.value.definitionDigest,
        target: {
          kind: "rotate_account",
          integrationAccountId: resumed.integrationAccountId,
          expectedBindingRevision: 3,
        },
        createdByUserId: adminId,
        now: 1_700,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "custom_connector_setup_conflict" },
    });
    database.close();
  });
});

async function testEasyPostSetup(): Promise<void> {
  const database = new DatabaseSync(":memory:");
  database.exec(baselineSql);
  seedIdentity(database);
  const db = d1Database(database);
  const keys = testVaultBindings();
  const organisationId = requireOrganisationId("organisation_custom_setup");
  const adminId = requireUserId("user_0f925c19-994a-51ec-99fd-76e584b4d4b0");
  const document = await prepareCustomConnectorDraftDocument(
    fixture("easypost-rest.json"),
  );
  if (!document.ok) throw new Error(document.error.code);
  const draft = await createCustomConnectorDraft({
    db,
    organisationId,
    createdByUserId: adminId,
    document: document.value,
    now: 100,
  });
  const validated = await validateCustomConnectorRevision({
    db,
    organisationId,
    connectorId: draft.connectorId,
    revision: draft.revision,
    authoringDigest: draft.authoringDigest,
    now: 110,
  });
  if (!validated.ok || validated.value.reviewState !== "validated")
    throw new Error("EasyPost fixture did not validate");
  const approved = await approveCustomConnectorRevision({
    db,
    organisationId,
    connectorId: draft.connectorId,
    revision: draft.revision,
    definitionDigest: validated.value.definitionDigest,
    approvedByUserId: adminId,
    review: {
      origin: validated.value.definition.origin,
      effects: approvalEffects(validated.value.definition.operations),
    },
    now: 120,
  });
  if (!approved.ok || approved.value.reviewState !== "approved")
    throw new Error("EasyPost fixture did not approve");
  const attempt = await startCustomConnectorSetup({
    db,
    organisationId,
    connectorId: draft.connectorId,
    connectorRevision: draft.revision,
    definitionDigest: approved.value.definitionDigest,
    target: { kind: "new_account", environment: "production" },
    createdByUserId: adminId,
    now: 130,
  });
  if (!attempt.ok) throw new Error(attempt.error.code);
  const attached = await attachCustomConnectorCandidateCredential({
    db,
    keys,
    organisationId,
    attemptId: attempt.value.attemptId,
    expectedAttemptRevision: attempt.value.attemptRevision,
    credentialValue: "EZAK_fixture_123",
    now: 140,
  });
  if (!attached.ok) throw new Error(attached.error.code);
  const tested = await testCustomConnectorCandidate({
    db,
    keys,
    organisationId,
    attemptId: attached.value.attemptId,
    expectedAttemptRevision: attached.value.attemptRevision,
    executor: easyPostIdentityTest,
    now: 150,
  });
  if (!tested.ok) throw new Error(tested.error.code);
  expect(tested.value.attempt.lifecycle).toBe("verified");
  expect(JSON.stringify(tested.value)).not.toContain("EZAK_");
  const authorization = await authorizeCustomConnectorSetupCommit({
    db,
    keys,
    organisationId,
    attemptId: tested.value.attempt.attemptId,
    expectedAttemptRevision: tested.value.attempt.attemptRevision,
    now: 160,
  });
  if (!authorization.ok) throw new Error(authorization.error.code);
  const committed = await commitNewCustomConnectorAccount({
    db,
    authorization: authorization.value,
    committedByUserId: adminId,
    expectedConfigurationVersion: 1,
    now: 170,
  });
  expect(committed).toMatchObject({
    ok: true,
    value: { lifecycle: { kind: "active" } },
  });
  database.close();
}

const easyPostIdentityTest: CustomConnectorIdentityTestExecutor =
  async function verifyEasyPostCredential(request) {
    expect(request.authentication).toEqual({
      kind: "basic_api_key",
      value: "EZAK_fixture_123",
    });
    expect(request.origin).toBe("https://api.easypost.com");
    expect(request.operation.transport.kind).toBe("get");
    if (request.operation.transport.kind === "mcp")
      throw new Error("Expected REST identity probe");
    expect(request.operation.transport.pathTemplate).toBe("/v2/users");
    return {
      ok: true,
      value: {
        providerAccountId: "user_easypost_fixture",
        displayName: "Café shipping",
        preview: { id: "user_easypost_fixture", name: "Café shipping" },
      },
    };
  };

async function createCommittedFixtureAccount(input: {
  readonly db: SingleDatabase;
  readonly keys: CredentialVaultBindings;
  readonly organisationId: OrganisationId;
  readonly adminId: UserId;
}): Promise<{
  readonly connectorId: CustomConnectorId;
  readonly revision: CustomConnectorRevision;
  readonly definitionDigest: CustomConnectorDefinitionDigest;
  readonly account: ActiveCustomConnectorAccount;
}> {
  const document = await prepareCustomConnectorDraftDocument(
    fixture("github-rest.json"),
  );
  if (!document.ok) throw new Error(document.error.code);
  const draft = await createCustomConnectorDraft({
    db: input.db,
    organisationId: input.organisationId,
    createdByUserId: input.adminId,
    document: document.value,
    now: 1_000,
  });
  const validated = await validateCustomConnectorRevision({
    db: input.db,
    organisationId: input.organisationId,
    connectorId: draft.connectorId,
    revision: draft.revision,
    authoringDigest: draft.authoringDigest,
    now: 1_010,
  });
  if (!validated.ok || validated.value.reviewState !== "validated") {
    throw new Error("fixture definition did not validate");
  }
  const approved = await approveCustomConnectorRevision({
    db: input.db,
    organisationId: input.organisationId,
    connectorId: draft.connectorId,
    revision: draft.revision,
    definitionDigest: validated.value.definitionDigest,
    approvedByUserId: input.adminId,
    review: {
      origin: validated.value.definition.origin,
      effects: approvalEffects(validated.value.definition.operations),
    },
    now: 1_020,
  });
  if (!approved.ok || approved.value.reviewState !== "approved") {
    throw new Error("fixture definition did not approve");
  }
  const started = await startCustomConnectorSetup({
    db: input.db,
    organisationId: input.organisationId,
    connectorId: draft.connectorId,
    connectorRevision: draft.revision,
    definitionDigest: approved.value.definitionDigest,
    target: { kind: "new_account", environment: "development" },
    createdByUserId: input.adminId,
    now: 1_030,
  });
  if (!started.ok) throw new Error(started.error.code);
  const attached = await attachCustomConnectorCandidateCredential({
    db: input.db,
    keys: input.keys,
    organisationId: input.organisationId,
    attemptId: started.value.attemptId,
    expectedAttemptRevision: started.value.attemptRevision,
    credentialValue: "candidate-secret-value",
    now: 1_040,
  });
  if (!attached.ok) throw new Error(attached.error.code);
  const tested = await testCustomConnectorCandidate({
    db: input.db,
    keys: input.keys,
    organisationId: input.organisationId,
    attemptId: attached.value.attemptId,
    expectedAttemptRevision: attached.value.attemptRevision,
    executor: successfulIdentityTest,
    now: 1_050,
  });
  if (!tested.ok) throw new Error(tested.error.code);
  const authorization = await authorizeCustomConnectorSetupCommit({
    db: input.db,
    keys: input.keys,
    organisationId: input.organisationId,
    attemptId: tested.value.attempt.attemptId,
    expectedAttemptRevision: tested.value.attempt.attemptRevision,
    now: 1_060,
  });
  if (!authorization.ok) throw new Error(authorization.error.code);
  const committed = await commitNewCustomConnectorAccount({
    db: input.db,
    authorization: authorization.value,
    committedByUserId: input.adminId,
    expectedConfigurationVersion: 1,
    now: 1_070,
  });
  if (!committed.ok) throw new Error(committed.error.code);
  return {
    connectorId: draft.connectorId,
    revision: draft.revision,
    definitionDigest: approved.value.definitionDigest,
    account: committed.value,
  };
}

async function commitExistingFixtureSetup(input: {
  readonly db: SingleDatabase;
  readonly keys: CredentialVaultBindings;
  readonly organisationId: OrganisationId;
  readonly adminId: UserId;
  readonly connectorId: CustomConnectorId;
  readonly connectorRevision: CustomConnectorRevision;
  readonly definitionDigest: CustomConnectorDefinitionDigest;
  readonly target: Exclude<CustomConnectorSetupTarget, { kind: "new_account" }>;
  readonly credentialValue: string;
  readonly executor: CustomConnectorIdentityTestExecutor;
  readonly expectedConfigurationVersion: number;
  readonly now: number;
}): Promise<ActiveCustomConnectorAccount> {
  const started = await startCustomConnectorSetup({
    db: input.db,
    organisationId: input.organisationId,
    connectorId: input.connectorId,
    connectorRevision: input.connectorRevision,
    definitionDigest: input.definitionDigest,
    target: input.target,
    createdByUserId: input.adminId,
    now: input.now,
  });
  if (!started.ok) throw new Error(started.error.code);
  const attached = await attachCustomConnectorCandidateCredential({
    db: input.db,
    keys: input.keys,
    organisationId: input.organisationId,
    attemptId: started.value.attemptId,
    expectedAttemptRevision: started.value.attemptRevision,
    credentialValue: input.credentialValue,
    now: input.now + 10,
  });
  if (!attached.ok) throw new Error(attached.error.code);
  const tested = await testCustomConnectorCandidate({
    db: input.db,
    keys: input.keys,
    organisationId: input.organisationId,
    attemptId: attached.value.attemptId,
    expectedAttemptRevision: attached.value.attemptRevision,
    executor: input.executor,
    now: input.now + 20,
  });
  if (!tested.ok) throw new Error(tested.error.code);
  const authorization = await authorizeCustomConnectorSetupCommit({
    db: input.db,
    keys: input.keys,
    organisationId: input.organisationId,
    attemptId: tested.value.attempt.attemptId,
    expectedAttemptRevision: tested.value.attempt.attemptRevision,
    now: input.now + 25,
  });
  if (!authorization.ok) throw new Error(authorization.error.code);
  const committed = await commitExistingCustomConnectorAccount({
    db: input.db,
    authorization: authorization.value,
    expectedConfigurationVersion: input.expectedConfigurationVersion,
    now: input.now + 30,
  });
  if (!committed.ok) throw new Error(committed.error.code);
  return committed.value;
}

function persistCustomReadGrant(
  database: DatabaseSync,
  organisationId: OrganisationId,
  initial: Readonly<{
    readonly connectorId: CustomConnectorId;
    readonly revision: CustomConnectorRevision;
    readonly definitionDigest: CustomConnectorDefinitionDigest;
    readonly account: ActiveCustomConnectorAccount;
  }>,
  adminId: UserId,
): void {
  database
    .prepare(
      `INSERT INTO access_grant (
         organisation_id, grant_id, subject_json, target_json, lifecycle,
         revision, reason, provenance_json, changed_at
       ) VALUES (?, 'grant_custom_rotation_fence', ?, ?, 'active', 1, NULL, ?, 1080)`,
    )
    .run(
      organisationId,
      JSON.stringify({ kind: "organisation_role", role: "admin" }),
      JSON.stringify({
        kind: "custom_connector_operation",
        capabilityId: "custom_connector.read",
        capabilityVersion: 1,
        integrationAccountId: initial.account.integrationAccountId,
        connectorId: initial.connectorId,
        definitionRevision: initial.revision,
        definitionDigest: initial.definitionDigest,
        operationId: "current_user",
      }),
      JSON.stringify({
        kind: "operator",
        userId: adminId,
        mutationReceiptId: "mutation_custom_rotation_fence",
      }),
    );
}

function readActiveCredentialRef(
  database: DatabaseSync,
  providerConnectionId: string,
): string {
  const row = database
    .prepare(
      `SELECT credential_ref AS credentialRef FROM provider_connection
       WHERE provider_connection_id = ?`,
    )
    .get(providerConnectionId);
  if (row === undefined || typeof row.credentialRef !== "string") {
    throw new Error("active credential reference is missing");
  }
  return row.credentialRef;
}

function readSetupCredentialRef(
  database: DatabaseSync,
  attemptId: string,
): string {
  const row = database
    .prepare(
      `SELECT candidate_credential_ref AS credentialRef
       FROM custom_connector_setup_attempt WHERE attempt_id = ?`,
    )
    .get(attemptId);
  if (row === undefined || typeof row.credentialRef !== "string") {
    throw new Error("setup credential reference is missing");
  }
  return row.credentialRef;
}

function readActiveCredentialGeneration(
  database: DatabaseSync,
  providerConnectionId: string,
): number {
  const row = database
    .prepare(
      `SELECT credential_generation AS credentialGeneration
       FROM provider_connection WHERE provider_connection_id = ?`,
    )
    .get(providerConnectionId);
  if (row === undefined || typeof row.credentialGeneration !== "number") {
    throw new Error("active credential generation is missing");
  }
  return row.credentialGeneration;
}

function readCredentialGenerationLifecycle(
  database: DatabaseSync,
  providerConnectionId: string,
  credentialGeneration: number,
): string {
  const row = database
    .prepare(
      `SELECT lifecycle FROM provider_credential_generation
       WHERE provider_connection_id = ? AND credential_generation = ?`,
    )
    .get(providerConnectionId, credentialGeneration);
  if (row === undefined || typeof row.lifecycle !== "string") {
    throw new Error("credential generation lifecycle is missing");
  }
  return row.lifecycle;
}

function readVaultRevokedAt(
  database: DatabaseSync,
  handle: string,
): number | null {
  const row = database
    .prepare(
      "SELECT revoked_at AS revokedAt FROM vault_secret WHERE vault_handle = ?",
    )
    .get(handle);
  if (
    row === undefined ||
    (typeof row.revokedAt !== "number" && row.revokedAt !== null)
  ) {
    throw new Error("Vault revocation state is missing");
  }
  return row.revokedAt;
}

const mismatchedIdentityTest: CustomConnectorIdentityTestExecutor =
  async function executeMismatchedIdentityTest() {
    return {
      ok: true,
      value: {
        providerAccountId: "another-account",
        displayName: "Another account",
        preview: { login: "another-account" },
      },
    };
  };

const rotatedIdentityTest: CustomConnectorIdentityTestExecutor =
  async function executeRotatedIdentityTest(request) {
    assertIdentityCredential(request, "rotated-secret");
    return successfulIdentityResult();
  };

const upgradedIdentityTest: CustomConnectorIdentityTestExecutor =
  async function executeUpgradedIdentityTest(request) {
    assertIdentityCredential(request, "upgraded-secret");
    return successfulIdentityResult();
  };

const resumedIdentityTest: CustomConnectorIdentityTestExecutor =
  async function executeResumedIdentityTest(request) {
    assertIdentityCredential(request, "resumed-secret");
    return successfulIdentityResult();
  };

function assertIdentityCredential(
  request: CustomConnectorIdentityTestRequest,
  expected: string,
): void {
  expect(request.authentication).toEqual({
    kind: "header",
    name: "authorization",
    value: expected,
  });
}

function successfulIdentityResult() {
  return {
    ok: true as const,
    value: {
      providerAccountId: "octocat",
      displayName: "The Octocat",
      preview: { login: "octocat" },
    },
  };
}

const successfulIdentityTest: CustomConnectorIdentityTestExecutor =
  async function successfulIdentityTestExecutor(
    request: CustomConnectorIdentityTestRequest,
  ) {
    expect(request.origin).toBe("https://api.github.com");
    expect(request.operation.id).toBe("current_user");
    expect(request.arguments).toEqual({});
    expect(request.authentication).toEqual({
      kind: "header",
      name: "authorization",
      value: "candidate-secret-value",
    });
    return {
      ok: true,
      value: {
        providerAccountId: "octocat",
        displayName: "The Octocat",
        preview: { login: "octocat" },
      },
    };
  };

function approvalEffects(
  operations: readonly { readonly id: string }[],
): readonly { readonly operationId: string; readonly effect: "read" }[] {
  const effects: { readonly operationId: string; readonly effect: "read" }[] =
    [];
  for (const operation of operations) {
    effects.push({ operationId: operation.id, effect: "read" });
  }
  return effects;
}

function fixture(name: string): JsonObject {
  const raw: unknown = JSON.parse(
    readFileSync(
      fileURLToPath(
        new NodeUrl(`fixtures/custom-connectors/${name}`, import.meta.url),
      ),
      "utf8",
    ),
  );
  if (!isJsonObject(raw)) {
    throw new Error("custom connector fixture is invalid");
  }
  return raw;
}

function isJsonObject(raw: unknown): raw is JsonObject {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return false;
  for (const value of Object.values(raw)) {
    if (!isJsonValue(value)) return false;
  }
  return true;
}

function isJsonValue(raw: unknown): boolean {
  if (raw === null || typeof raw === "string" || typeof raw === "boolean") {
    return true;
  }
  if (typeof raw === "number") return Number.isFinite(raw);
  if (Array.isArray(raw)) {
    for (const value of raw) {
      if (!isJsonValue(value)) return false;
    }
    return true;
  }
  return isJsonObject(raw);
}

function seedIdentity(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO organisation (organisation_id, organisation_handle, name, created_at)
    VALUES ('organisation_custom_setup', 'custom-setup', 'Custom setup', 1);
    INSERT INTO app_user (
      user_id, issuer, subject, email, display_name,
      email_verified, created_at, last_authenticated_at
    ) VALUES (
      'user_0f925c19-994a-51ec-99fd-76e584b4d4b0', 'test', 'custom-setup', 'setup@example.com',
      'Setup admin', 1, 1, 1
    );
    INSERT INTO organisation_onboarding (
      organisation_id, environment, lifecycle, capability_profile,
      configuration_version, projection_revision, activation_attempt_id,
      readiness_version, activation_receipt_id, activated_at,
      suspension_reason_code, suspended_at, archived_at, purge_after, updated_at
    ) VALUES (
      'organisation_custom_setup', 'development', 'configuring', 'read_and_propose',
      1, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1
    );
    INSERT INTO person (organisation_id, person_id, display_name, avatar_url)
    VALUES ('organisation_custom_setup', 'person_custom_setup', 'Setup admin', NULL);
    INSERT INTO service_role_grant (
      organisation_id, user_id, person_id, role, status, created_at, revoked_at
    ) VALUES (
      'organisation_custom_setup', 'user_0f925c19-994a-51ec-99fd-76e584b4d4b0', 'person_custom_setup',
      'admin', 'active', 1, NULL
    );
    INSERT INTO policy_snapshot (organisation_id, version, body, created_at, created_by)
    VALUES (
      'organisation_custom_setup', 1,
      '{"version":1,"egress":{"allowedHosts":[],"injections":[],"modelRoute":{"baseUrl":"https://unavailable.invalid"}},"authz":{"allowedTools":["custom_connector.read"],"deniedTools":[],"approvalRequired":[],"maxBudget":{"maxTokens":64000,"maxWallMs":180000,"maxToolCalls":20}},"conversationRisk":{"outputScreeningMode":"hold"},"createdAt":1}',
      1, 'test'
    );
  `);
}

function testVaultBindings(): CredentialVaultBindings {
  const bytes = new Uint8Array(32);
  bytes.fill(17);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return {
    PANTRY_VAULT_ACTIVE_KEY_VERSION: "v1",
    VAULT_ROOT_V1: new TestSecretsStoreSecret(
      btoa(binary),
    ) as SecretsStoreSecret,
  };
}

async function testWritePreview(): Promise<void> {
  const database = new DatabaseSync(":memory:");
  database.exec(baselineSql);
  seedIdentity(database);
  const db = d1Database(database);
  const keys = testVaultBindings();
  const organisationId = requireOrganisationId("organisation_custom_setup");
  const adminId = requireUserId("user_0f925c19-994a-51ec-99fd-76e584b4d4b0");
  const existing = await createCommittedFixtureAccount({
    db,
    keys,
    organisationId,
    adminId,
  });
  const base = fixture("github-rest.json");
  if (!Array.isArray(base.operations))
    throw new Error("fixture operations missing");
  const document = await prepareCustomConnectorDraftDocument({
    ...base,
    operations: [
      ...base.operations,
      {
        id: "create_product",
        description: "Create a product",
        effect: {
          kind: "external_record_create",
          retryPolicy: { kind: "single_attempt" },
        },
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            price: { type: "number", minimum: 0, maximum: 10000 },
            active: { type: "boolean" },
            note: { type: ["string", "null"], minLength: 0, maxLength: 200 },
          },
          required: ["name", "price", "active", "note"],
          additionalProperties: false,
        },
        transport: {
          kind: "rest",
          method: "POST",
          pathTemplate: "/products",
          pathBindings: {},
          queryBindings: { source: { kind: "constant", value: "portal" } },
          bodyBindings: {
            name: { kind: "input", field: "name" },
            price: { kind: "input", field: "price" },
            active: { kind: "input", field: "active" },
            note: { kind: "input", field: "note" },
            currency: { kind: "constant", value: "JPY" },
          },
        },
        response: {
          successStatuses: [201],
          resultPointer: "",
          outputSchema: {
            type: "object",
            properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
            required: ["id"],
            additionalProperties: false,
          },
          classification: "internal",
        },
        pagination: { kind: "none" },
      },
    ],
  });
  if (!document.ok) throw new Error(document.error.code);
  const draft = await createCustomConnectorRevision({
    db,
    organisationId,
    connectorId: existing.connectorId,
    expectedHeadRevision: existing.revision,
    createdByUserId: adminId,
    document: document.value,
    now: 2000,
  });
  if (!draft.ok) throw new Error(draft.error.code);
  const validated = await validateCustomConnectorRevision({
    db,
    organisationId,
    connectorId: existing.connectorId,
    revision: draft.value.revision,
    authoringDigest: draft.value.authoringDigest,
    now: 2010,
  });
  if (!validated.ok || validated.value.reviewState !== "validated")
    throw new Error(JSON.stringify(validated));
  const effects: {
    operationId: string;
    effect: "read" | "external_record_create" | "external_record_update";
  }[] = [];
  for (const operation of validated.value.definition.operations)
    effects.push({ operationId: operation.id, effect: operation.effect.kind });
  const approved = await approveCustomConnectorRevision({
    db,
    organisationId,
    connectorId: existing.connectorId,
    revision: draft.value.revision,
    definitionDigest: validated.value.definitionDigest,
    approvedByUserId: adminId,
    review: { origin: validated.value.definition.origin, effects },
    now: 2020,
  });
  if (!approved.ok || approved.value.reviewState !== "approved")
    throw new Error("write definition did not approve");
  const account = await commitExistingFixtureSetup({
    db,
    keys,
    organisationId,
    adminId,
    connectorId: existing.connectorId,
    connectorRevision: draft.value.revision,
    definitionDigest: approved.value.definitionDigest,
    target: {
      kind: "upgrade_account",
      integrationAccountId: existing.account.integrationAccountId,
      expectedBindingRevision: 1,
    },
    credentialValue: "upgraded-secret",
    executor: upgradedIdentityTest,
    expectedConfigurationVersion: 2,
    now: 2030,
  });
  const operation = approved.value.definition.operations.find(isCreateProduct);
  if (operation === undefined) throw new Error("write operation missing");
  const entry: CustomConnectorWriteCatalogEntry = {
    toolName: "create_product",
    description: operation.description,
    origin: approved.value.definition.origin,
    authentication: approved.value.definition.authentication,
    limits: approved.value.definition.limits,
    inputSchema: operation.inputSchema,
    organisationId,
    integrationAccountId: account.integrationAccountId,
    connectorId: existing.connectorId,
    definitionRevision: approved.value.revision,
    definitionDigest: approved.value.definitionDigest,
    bindingRevision: account.binding.bindingRevision,
    credentialGeneration: account.binding.credentialGeneration,
    operation,
    capabilityKey: "preview-fixture",
    grantIds: [],
    grantRevisions: [],
  };
  const rawArguments = {
    name: "Matcha bun",
    price: 0,
    active: false,
    note: null,
  };
  const authority = await buildCustomConnectorWriteAuthority({
    entry,
    rawArguments,
    providerEffectId: "preview-effect",
  });
  if (!authority.ok) throw new Error(authority.error.code);
  const preview = await resolveCustomConnectorWritePreview({
    db,
    organisationId,
    integrationAccountId: account.integrationAccountId,
    authority: authority.value,
  });
  expect(preview).toEqual({
    kind: "available",
    accountDisplayName: "The Octocat",
    operationLabel: "Create a product",
    origin: "https://api.github.com",
    method: "POST",
    path: "/products",
    fields: [
      { path: "query.source", value: "portal" },
      { path: "body.active", value: false },
      { path: "body.currency", value: "JPY" },
      { path: "body.name", value: "Matcha bun" },
      { path: "body.note", value: null },
      { path: "body.price", value: 0 },
    ],
  });
  const request = buildCustomConnectorOperationRequest(entry, rawArguments);
  if (
    !request.ok ||
    request.value.kind !== "post_json" ||
    preview.kind !== "available"
  )
    throw new Error("preview unavailable");
  const requestBody: unknown = JSON.parse(
    new TextDecoder().decode(request.value.body),
  );
  const previewBody: Record<string, unknown> = {};
  for (const field of preview.fields)
    if (field.path.startsWith("body."))
      previewBody[field.path.slice(5)] = field.value;
  expect(previewBody).toEqual(requestBody);
  expect(JSON.stringify(preview)).not.toContain("upgraded-secret");
  expect(
    await resolveApprovedCustomConnectorWrite({
      db,
      organisationId,
      integrationAccountId: account.integrationAccountId,
      authority: authority.value,
    }),
  ).toMatchObject({ ok: true });
  const tampered = {
    ...authority.value,
    canonicalInputJson:
      '{"name":"Changed","price":0,"active":false,"note":null}',
  };
  expect(
    await resolveCustomConnectorWritePreview({
      db,
      organisationId,
      integrationAccountId: account.integrationAccountId,
      authority: tampered,
    }),
  ).toEqual({ kind: "unavailable", reason: "input_invalid" });
  const wrongOrganisation = requireOrganisationId("organisation_wrong");
  expect(
    await resolveCustomConnectorWritePreview({
      db,
      organisationId: wrongOrganisation,
      integrationAccountId: account.integrationAccountId,
      authority: authority.value,
    }),
  ).toEqual({ kind: "unavailable", reason: "definition_unavailable" });
  const detail = await resolveCustomConnectorDetail({
    db,
    organisationId,
    connectorId: existing.connectorId,
  });
  expect(detail).toMatchObject({
    ok: true,
    value: {
      summary: {
        accounts: [
          {
            integrationAccountId: account.integrationAccountId,
            displayName: "The Octocat",
          },
        ],
      },
    },
  });
  database.close();
}
function isCreateProduct(
  operation: CustomConnectorOperation,
): operation is CustomConnectorWriteCatalogEntry["operation"] {
  return operation.id === "create_product" && operation.effect.kind !== "read";
}
