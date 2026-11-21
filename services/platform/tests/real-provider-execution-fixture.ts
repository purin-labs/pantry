import type { SingleDatabase } from "../src/database-handles";
import { createHash } from "node:crypto";
import type {
  AuthorityPartition,
  RequestAuthority,
} from "@purin-labs/contracts";
import { upsertUser } from "../src/data/control-plane";
import { createAccessGrant } from "../src/data/access-grants";
import { ensureInitialOrganisationPlacement } from "../src/data/shared-rows/placement-row";
import { defaultDenyPolicy } from "../src/policy-snapshot";
import type { IntegrationAccountId, OrganisationId } from "../src/ids";
import { createMigratedDatabase } from "./sqlite-d1";
import { platformEnv } from "./worker-fakes";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
import {
  TEST_INITIAL_ORGANISATION_PLACEMENT,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
import { fixtureProviderActionAuthority } from "./fixtures/plan25-turn";

const PROVIDER_SLACK_ACCOUNT = "integration_provider_slack";

/** The authenticated Slack origin is independent from the provider action target. */
export function realProviderActionAuthority(
  input: Readonly<{
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
    providerResourceScope: string;
  }>,
) {
  const target = fixtureProviderActionAuthority(input);
  const requestAuthority: Extract<
    RequestAuthority,
    { kind: "direct_conversation" }
  > = {
    kind: "direct_conversation",
    organisationId: input.organisationId,
    requesterPersonId: "person_fixture",
    membershipRevision: 1,
    role: "operator",
    connectorId: `connector_slack_${PROVIDER_SLACK_ACCOUNT}`,
    integrationAccountId: PROVIDER_SLACK_ACCOUNT,
    conversationId: "conversation_fixture",
  };
  const partition = {
    key: {
      kind: requestAuthority.kind,
      organisationId: requestAuthority.organisationId,
      requesterPersonId: requestAuthority.requesterPersonId,
      membershipRevision: requestAuthority.membershipRevision,
      role: requestAuthority.role,
      integrationAccountId: requestAuthority.integrationAccountId,
      conversationId: requestAuthority.conversationId,
    },
    selectedGrantSetDigest: target.authorityPartition.selectedGrantSetDigest,
    capabilityKeys: target.authorityPartition.capabilityKeys,
    policyVersion: target.authorityPartition.policyVersion,
  };
  const authorityPartition: AuthorityPartition = {
    digest: createHash("sha256")
      .update(JSON.stringify(partition))
      .digest("hex"),
    ...partition,
  };
  return { requestAuthority, authorityPartition };
}

/** Native admission stays real. Provider network responses remain owned by each scenario. */
export async function realProviderExecutionFixture(
  input: Readonly<{
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
    capabilityId: string;
    resourceScope: string;
    grantActive: boolean;
  }>,
) {
  const db = createMigratedDatabase();
  const owner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "provider-fixture-owner",
      email: "provider-owner@example.test",
      displayName: "Provider owner",
      emailVerified: true,
    },
    now: Date.now(),
  });
  const operator = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "provider-fixture-operator",
      email: "provider-operator@example.test",
      displayName: "Provider operator",
      emailVerified: true,
    },
    now: Date.now(),
  });
  await db.batch([
    db
      .prepare(
        "INSERT INTO organisation (organisation_id, organisation_handle, name, created_at) VALUES (?, 'provider-fixture', 'Provider fixture', 1)",
      )
      .bind(input.organisationId),
    db
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, 'person_provider_owner', 'Provider owner'), (?, 'person_fixture', 'Provider operator')",
      )
      .bind(input.organisationId, input.organisationId),
    db
      .prepare(
        "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at) VALUES (?, ?, 'person_provider_owner', 'owner', 'active', 1), (?, ?, 'person_fixture', 'operator', 'active', 1)",
      )
      .bind(
        input.organisationId,
        owner.userId,
        input.organisationId,
        operator.userId,
      ),
    db
      .prepare(
        "INSERT INTO organisation_onboarding (organisation_id, environment, lifecycle, capability_profile, configuration_version, projection_revision, activation_receipt_id, activated_at, updated_at) VALUES (?, 'development', 'active', 'read_and_propose', 1, 1, 'provider-fixture', 1, 1)",
      )
      .bind(input.organisationId),
  ]);
  await ensureInitialOrganisationPlacement({
    db,
    organisationId: input.organisationId,
    environment: "development",
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: 1,
  });
  await seedNativeProviderAccount(
    db,
    input.organisationId,
    PROVIDER_SLACK_ACCOUNT,
    "slack",
    owner.userId,
  );
  await seedNativeProviderAccount(
    db,
    input.organisationId,
    input.integrationAccountId,
    input.integrationAccountId.includes("shopify") ? "shopify" : "commerce",
    owner.userId,
  );
  const policy = defaultDenyPolicy({ now: 1 });
  policy.version = 1;
  policy.authz.allowedTools = [input.capabilityId];
  await db
    .prepare(
      "INSERT INTO policy_snapshot (organisation_id, version, body, created_at, created_by) VALUES (?, 1, ?, 1, 'provider-fixture')",
    )
    .bind(input.organisationId, JSON.stringify(policy))
    .run();
  if (input.grantActive) {
    const grant = await createAccessGrant({
      db,
      organisationId: input.organisationId,
      grantId: `grant_provider_action_${input.integrationAccountId}`,
      subject: { kind: "organisation_role", role: "operator" },
      target: {
        kind: "provider_resource",
        capabilityId: input.capabilityId,
        capabilityVersion: 1,
        integrationAccountId: input.integrationAccountId,
        resourceScope: input.resourceScope,
      },
      provenance: {
        kind: "cutover",
        migrationId: "plan35-provider-dispatch-fixture",
        originalChangedAt: 1,
      },
      now: 1,
    });
    if (!grant.ok) throw new Error(grant.error.code);
  }
  const testEnv = platformEnv({
    DB: db,
    PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
  });
  return {
    env: testEnv,
    scope: await requireOrganisationExecutionScope(
      testEnv,
      input.organisationId,
    ),
  };
}

export async function seedNativeProviderAccount(
  db: SingleDatabase,
  organisationId: OrganisationId,
  integrationAccountId: string,
  provider: string,
  ownerUserId: string,
): Promise<void> {
  const connectionId = `connection_${integrationAccountId}`;
  const credentialRef = `vault:${integrationAccountId}`;
  await db.batch([
    db
      .prepare(
        "INSERT INTO provider_connection (provider_connection_id, organisation_id, provider, auth_mode, authority_kind, credential_generation, credential_ref, lifecycle, granted_scopes, created_by_user_id, created_at, updated_at, environment, provider_subject_id) VALUES (?, ?, ?, 'api_key', 'connection_credential', 1, ?, 'active', '[]', ?, 1, 1, 'development', ?)",
      )
      .bind(
        connectionId,
        organisationId,
        provider,
        credentialRef,
        ownerUserId,
        integrationAccountId,
      ),
    db
      .prepare(
        "INSERT INTO provider_credential_generation (provider_connection_id, credential_generation, organisation_id, provider, environment, credential_ref, lifecycle, created_at, activated_at) VALUES (?, 1, ?, ?, 'development', ?, 'active', 1, 1)",
      )
      .bind(connectionId, organisationId, provider, credentialRef),
    db
      .prepare(
        "INSERT INTO integration_account (integration_account_id, organisation_id, provider_connection_id, provider, provider_account_id, account_kind, display_name, lifecycle, capability_set, audience_policy, retention_policy, created_at, updated_at, environment) VALUES (?, ?, ?, ?, ?, 'commerce', 'Provider fixture', 'active', '[]', '{\"kind\":\"operator\"}', '{\"kind\":\"organisation_default\"}', 1, 1, 'development')",
      )
      .bind(
        integrationAccountId,
        organisationId,
        connectionId,
        provider,
        integrationAccountId,
      ),
  ]);
}
