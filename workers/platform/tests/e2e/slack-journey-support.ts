import type { ConnectorDeliveryReceipt } from "@purin-labs/contracts";
import {
  fixtureDatabase,
  organisationDatabase,
  publishGlobalOrganisation,
} from "./organisation-database";
import { env, exports } from "cloudflare:workers";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect } from "vitest";

import { CONTEXT_CASE_READ_CAPABILITY } from "@purin-labs/authority/authorization/access-grants/turn-authority";
import { encodeContextVisibility } from "@purin-labs/authority/authorization/access-grants/visibility";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import type { CaseSnapshot } from "@purin-labs/conversation/actors/case/types";
import {
  applyFileProjectionCommand,
  createFileProjectionCommand,
  replaceFileGrantAdmissions,
  upsertFileResourceSource,
  type FileProjectionSourceReader,
} from "@purin-labs/agent/context/files/index";
import {
  parseVaultHandle,
  storeVaultSecret,
} from "@purin-labs/authority/credential-vault/index";
import { createAccessGrant } from "@purin-labs/authority/data/access-grants";
import { createActiveConnectedIntegration } from "@purin-labs/connections/data/integration-account";
import { createOrganisationInstall } from "@purin-labs/tenancy/data/organisation";
import {
  issueControlSession,
  upsertUser,
  type IssuedControlSession,
} from "@purin-labs/tenancy/data/control-plane";
import {
  parseSessionId,
  parseOrganisationId,
  parseWorkspaceId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { parseUserId } from "@purin-labs/control-api/ids";
import { parseInitialOrganisationPlacement } from "@purin-labs/tenancy/placement";
import { compilePublishAndActivateOrganisationPolicy } from "@purin-labs/authority/policy-snapshot";
import { isRecord } from "@purin-labs/std";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { PLATFORM_DEFAULT_PI_MODEL } from "@purin-labs/agent/actors/pi-model-transport";
export const SLACK_SIGNING_SECRET = "slack-signing-e2e-secret";
export const ORGANISATION_ID = requiredOrganisationId(
  "organisation_e2e_slack_actor",
);
export const OTHER_ORGANISATION_ID = requiredOrganisationId(
  "organisation_e2e_slack_other",
);
export const WORKSPACE_ID = requiredWorkspaceId("T0E2EACTOR");
export const CHANNEL_ID = "C0E2EACTOR";
export const USER_ID = "U0E2EACTOR";
/**
 * The Pantry user that `installSlackActorFixture` links to the Slack actor. A
 * journey that changes the actor's role must name this user: the fixture's
 * owner keeps its role, because an Organisation keeps at least one owner.
 */
export const SLACK_ACTOR_USER_ID = "user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab";
export const ROOT_TS = "1787500000.000001";
export const SLACK_BOT_TOKEN = "xoxb-e2e-actor";
export const OTHER_WORKSPACE_ID = requiredWorkspaceId("T0E2EOTHER");
export const OTHER_CHANNEL_ID = "C0E2EOTHER";
export const OTHER_SLACK_BOT_TOKEN = "xoxb-e2e-other";
export const REVOKED_USER_ID = "U0E2EREVOKED";
export const DISCOVERY_GRANT_ID = "grant_e2e_integration_discovery";
export const DISCOVERY_ANSWER =
  "Connected: Dropbox, Gmail, Slack, and Stripe. Only Dropbox files are readable here.";
export const DISCOVERY_UNAVAILABLE =
  "Integration discovery is unavailable for this thread.";

export async function installSlackActorFixture(): Promise<{
  readonly connectorId: string;
  readonly selectedIntegrationAccountId: string;
  readonly selectedConnectionId: string;
  /** The Organisation owner's Portal session. */
  readonly ownerSession: IssuedControlSession;
}> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO app_user (
         user_id, issuer, subject, email, display_name,
         email_verified, created_at, last_authenticated_at
       ) VALUES (
         'user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab', 'https://accounts.google.com',
         'e2e-slack-actor', 'e2e-slack-actor@example.invalid',
         'E2E Slack Actor', 1, ?, ?
       )`,
    ).bind(now - 1_000, now - 1_000),
  ]);
  const install = await installOperationsChannel(
    ORGANISATION_ID,
    SLACK_ACTOR_USER_ID,
    now,
  );
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        `UPDATE organisation_onboarding
       SET lifecycle = 'configuring',
           activation_attempt_id = NULL,
           readiness_version = NULL,
           activation_receipt_id = NULL,
           activated_at = NULL
       WHERE organisation_id = ?`,
      )
      .bind(ORGANISATION_ID),
    fixtureDatabase()
      .prepare(
        `INSERT INTO person (organisation_id, person_id, display_name)
       VALUES (?, 'person_e2e-slack-actor', 'E2E Slack Actor')`,
      )
      .bind(ORGANISATION_ID),
    fixtureDatabase()
      .prepare(
        `INSERT INTO service_role_grant (
         organisation_id, user_id, person_id, role, status, created_at, revoked_at
       ) VALUES (
         ?, 'user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab', 'person_e2e-slack-actor',
         'operator', 'active', ?, NULL
       )`,
      )
      .bind(ORGANISATION_ID, now - 1_000),
    fixtureDatabase()
      .prepare(
        `INSERT INTO external_identity_link (
         organisation_id, workspace_connection_id, workspace_id, external_user_id,
         user_id, verified_at, verified_by
       ) VALUES (
         ?, ?, ?, ?, 'user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab', ?, 'google'
       )`,
      )
      .bind(
        ORGANISATION_ID,
        install.providerConnectionId,
        WORKSPACE_ID,
        USER_ID,
        now - 900,
      ),
    fixtureDatabase()
      .prepare(
        `INSERT INTO organisation_inference_selection (
         organisation_id, selection_kind, selected_by_user_id, selected_at
       ) VALUES (?, 'pantry_platform', 'user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab', ?)`,
      )
      .bind(ORGANISATION_ID, now - 700),
  ]);

  const contextGrant = await createAccessGrant({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    grantId: "grant_e2e_context_case_read",
    subject: { kind: "organisation_role", role: "operator" },
    target: {
      kind: "platform_capability",
      capabilityId: CONTEXT_CASE_READ_CAPABILITY,
      capabilityVersion: 1,
    },
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: "receipt_e2e_slack",
    },
    now: now - 500,
  });
  if (!contextGrant.ok) {
    throw new Error("E2E Slack access grants failed");
  }

  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now,
  });
  await organisation.ensureOrganisation({
    organisationId: ORGANISATION_ID,
    name: "E2E Slack actor",
    plan: "beta",
    status: "active",
    createdAt: now - 2_000,
  });
  const published = await compilePublishAndActivateOrganisationPolicy({
    bindings: { db: fixtureDatabase(), kv: env.POLICY_KV },
    organisationId: ORGANISATION_ID,
    organisation,
    now,
  });
  if (!published.ok) throw new Error(published.error.code);
  const owner = await seedSlackActorOwner({
    organisationId: ORGANISATION_ID,
    owner: { subject: "e2e-slack-owner", name: "E2E Slack Owner" },
    actor: { subject: "e2e-slack-actor", name: "E2E Slack Actor" },
    now,
  });

  return {
    connectorId: `connector_slack_${install.integrationAccountId}`,
    selectedIntegrationAccountId: install.integrationAccountId,
    selectedConnectionId: install.providerConnectionId,
    ownerSession: owner.session,
  };
}

/**
 * The fixture's Slack workspace, installed for one Organisation, with its
 * channel selected as the operations channel: the channel of the cards that
 * no agent turn writes, such as device alerts. `slackSimulator` is Slack.
 * `boundBy` is the user who selected the channel.
 */
export async function installOperationsChannel(
  organisationId: OrganisationId,
  boundBy: string,
  now: number = Date.now(),
): Promise<
  Readonly<{ integrationAccountId: string; providerConnectionId: string }>
> {
  const tokenHandle = requiredVaultHandle("vault:slack:bot:e2e-actor");
  const install = await createOrganisationInstall(
    organisationDatabase(organisationId),
    env.DB,
    {
      organisationId,
      name: "E2E Slack actor",
      surfaceKind: "slack",
      workspaceId: WORKSPACE_ID,
      installModel: "unlisted",
      botTokenRef: tokenHandle,
      scopes: [
        "app_mentions:read",
        "assistant:write",
        "channels:history",
        "channels:read",
        "chat:write",
      ],
      placement: requiredPlacement(),
      createdAt: now - 2_000,
      installedAt: now - 1_000,
    },
  );
  const database = organisationDatabase(organisationId);
  const connection = await database
    .prepare(
      `SELECT provider_connection_id AS providerConnectionId
     FROM integration_account
     WHERE integration_account_id = ?`,
    )
    .bind(install.integrationAccountId)
    .first<{ readonly providerConnectionId: string }>();
  if (connection === null) throw new Error("E2E Slack connection missing");
  const stored = await storeVaultSecret({
    db: database,
    keys: env,
    organisationId,
    handle: tokenHandle,
    secret: { kind: "bearer", value: SLACK_BOT_TOKEN },
    now,
  });
  if (!stored.ok) throw new Error(stored.error.code);
  await publishGlobalOrganisation(organisationId);
  await database.batch(
    [
      "organisation_communication_destination (organisation_id, integration_account_id, workspace_id, channel_id, provider_revision, selected_at)",
      "organisation_slack_channel (organisation_id, integration_account_id, workspace_id, channel_id, provider_revision, connected_at)",
    ].map((table) =>
      database
        .prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?, 'channel-e2e-1', ?)`)
        .bind(
          organisationId,
          install.integrationAccountId,
          WORKSPACE_ID,
          CHANNEL_ID,
          now - 800,
        ),
    ),
  );
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO slack_installation (
      installation_id, environment, app_id, workspace_id, credential_organisation_id,
      bot_token_ref, install_model, scopes_json, lifecycle, installed_at, updated_at,
      disabled_at, revoked_at
    ) VALUES ('installation_e2e_slack', 'development', 'A12345678', ?, ?, ?,
      'unlisted', '["chat:write"]', 'active', ?, ?, NULL, NULL)`,
    ).bind(WORKSPACE_ID, organisationId, tokenHandle, now, now),
    env.DB.prepare(
      `INSERT INTO slack_organisation_connection (
      connection_id, installation_id, organisation_id, integration_account_id,
      lifecycle, revision, connected_at, updated_at, disabled_at, revoked_at
    ) VALUES ('connection_e2e_slack_org', 'installation_e2e_slack', ?, ?,
      'active', 1, ?, ?, NULL, NULL)`,
    ).bind(organisationId, install.integrationAccountId, now, now),
    env.DB.prepare(
      `INSERT INTO slack_channel_default (
      installation_id, channel_id, connection_id, revision, bound_by_user_id, bound_at
    ) VALUES ('installation_e2e_slack', ?, 'connection_e2e_slack_org', 1, ?, ?)`,
    ).bind(CHANNEL_ID, boundBy, now),
  ]);
  return {
    integrationAccountId: install.integrationAccountId,
    providerConnectionId: connection.providerConnectionId,
  };
}

/**
 * The account authority admits every request and every Slack event. It maps
 * its owner to the native owner grant, and it admits the linked Slack actor as
 * the Organisation's operator. The actor must already hold its native grant.
 * It also admits the optional private member and extra members.
 */
/**
 * Records one discovery of the fixture's Slack channel, as the Portal's
 * resource refresh writes it: Pantry connects a channel only from such a list.
 * The newest discovery tells the Portal if the channel is public (Plan 27C).
 */
export async function discoverSlackChannel(
  kind: "public_channel" | "private_channel",
  at: number = Date.now(),
): Promise<void> {
  const connected = await fixtureDatabase()
    .prepare(
      "SELECT integration_account_id FROM organisation_slack_channel WHERE organisation_id = ? AND channel_id = ?",
    )
    .bind(ORGANISATION_ID, CHANNEL_ID)
    .first<{ integration_account_id: string }>();
  if (connected === null) throw new Error("Slack channel missing");
  const snapshot = `snapshot_slack_channel_${kind}_${String(at)}`;
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        `INSERT INTO provider_resource_snapshot (
         snapshot_revision, organisation_id, integration_account_id, provider,
         environment, query_hash, created_at
       ) VALUES (?, ?, ?, 'slack', 'development', 'slack-channel-query', ?)`,
      )
      .bind(snapshot, ORGANISATION_ID, connected.integration_account_id, at),
    fixtureDatabase()
      .prepare(
        `INSERT INTO provider_discovered_resource (
         snapshot_revision, canonical_resource_id, provider_resource_id,
         provider_account_id, display_label, access_state, provider_revision,
         resource_kind
       ) VALUES (?, ?, ?, ?, '#bakery', 'accessible', 'channel-e2e-1', ?)`,
      )
      .bind(snapshot, CHANNEL_ID, CHANNEL_ID, WORKSPACE_ID, kind),
  ]);
}

/**
 * The owner of the Slack fixture Organisation, and the Slack actor's signed-in
 * person, who has no role yet.
 */
export async function seedSlackActorOwner(
  input: Readonly<{
    organisationId: OrganisationId;
    owner: Readonly<{ subject: string; name: string }>;
    actor: Readonly<{ subject: string; name: string }>;
    now: number;
  }>,
): Promise<Awaited<ReturnType<typeof googleClient>>> {
  const { organisationId, now } = input;
  const personId = `person_${input.owner.subject}`;
  const owner = await googleClient(input.owner.subject, input.owner.name, now);
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        `INSERT INTO person (organisation_id, person_id, display_name)
       VALUES (?, ?, ?)`,
      )
      .bind(organisationId, personId, input.owner.name),
    fixtureDatabase()
      .prepare(
        `INSERT INTO service_role_grant (
         organisation_id, user_id, person_id, role, status, created_at, revoked_at
       ) VALUES (?, ?, ?, 'owner', 'active', ?, NULL)`,
      )
      .bind(organisationId, owner.identity.userId, personId, now - 1_000),
  ]);
  await googleClient(input.actor.subject, input.actor.name, now);
  return owner;
}

/**
 * The owner of the `installSlackActorFixture` Organisation, with a fresh
 * control session. A journey uses it for an owner's account changes.
 */
export function slackActorFixtureOwner(now: number = Date.now()) {
  return googleClient("e2e-slack-owner", "E2E Slack Owner", now);
}

async function googleClient(subject: string, displayName: string, now: number) {
  const identity = await upsertUser({
    db: env.DB,
    identity: {
      issuer: "https://accounts.google.com",
      subject,
      email: `${subject}@example.invalid`,
      displayName,
      emailVerified: true,
    },
    now,
  });
  const session = await issueControlSession({
    db: env.DB,
    userId: identity.userId,
    now,
    ttlMs: 30 * 60 * 1_000,
  });
  return { identity, session };
}

export async function installDiscoveryActorFixture(): Promise<{
  readonly selectedIntegrationAccountId: string;
  readonly otherIntegrationAccountId: string;
  /** The Organisation owner's Portal session. */
  readonly ownerSession: IssuedControlSession;
}> {
  const base = await installSlackActorFixture();
  const now = Date.now();
  const owner = requiredUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab");
  const otherInstall = await createOrganisationInstall(
    organisationDatabase(OTHER_ORGANISATION_ID),
    env.DB,
    {
      organisationId: OTHER_ORGANISATION_ID,
      name: "Other E2E Slack organisation",
      surfaceKind: "slack",
      workspaceId: OTHER_WORKSPACE_ID,
      installModel: "unlisted",
      botTokenRef: requiredVaultHandle("vault:slack:bot:e2e-other"),
      scopes: [
        "app_mentions:read",
        "assistant:write",
        "channels:history",
        "channels:read",
        "chat:write",
      ],
      placement: requiredPlacement(),
      createdAt: now - 700,
      installedAt: now - 600,
    },
  );
  const otherCredential = await storeVaultSecret({
    db: fixtureDatabase(),
    keys: env,
    organisationId: OTHER_ORGANISATION_ID,
    handle: requiredVaultHandle("vault:slack:bot:e2e-other"),
    secret: { kind: "bearer", value: OTHER_SLACK_BOT_TOKEN },
    now,
  });
  if (!otherCredential.ok) throw new Error(otherCredential.error.code);
  await publishGlobalOrganisation(OTHER_ORGANISATION_ID);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO slack_installation (
      installation_id, environment, app_id, workspace_id, credential_organisation_id,
      bot_token_ref, install_model, scopes_json, lifecycle, installed_at, updated_at,
      disabled_at, revoked_at
    ) VALUES ('installation_e2e_other', 'development', 'A12345678', ?, ?, ?,
      'unlisted', '["chat:write"]', 'active', ?, ?, NULL, NULL)`,
    ).bind(
      OTHER_WORKSPACE_ID,
      OTHER_ORGANISATION_ID,
      requiredVaultHandle("vault:slack:bot:e2e-other"),
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO slack_organisation_connection (
      connection_id, installation_id, organisation_id, integration_account_id,
      lifecycle, revision, connected_at, updated_at, disabled_at, revoked_at
    ) VALUES ('connection_e2e_other_org', 'installation_e2e_other', ?, ?,
      'active', 1, ?, ?, NULL, NULL)`,
    ).bind(OTHER_ORGANISATION_ID, otherInstall.integrationAccountId, now, now),
    env.DB.prepare(
      `INSERT INTO slack_channel_default (
      installation_id, channel_id, connection_id, revision, bound_by_user_id, bound_at
    ) VALUES ('installation_e2e_other', ?, 'connection_e2e_other_org', 1, 'user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab', ?)`,
    ).bind(OTHER_CHANNEL_ID, now),
  ]);

  const otherConnection = await fixtureDatabase()
    .prepare(
      `SELECT provider_connection_id AS providerConnectionId
       FROM integration_account
      WHERE integration_account_id = ?`,
    )
    .bind(otherInstall.integrationAccountId)
    .first<{ readonly providerConnectionId: string }>();
  if (otherConnection === null)
    throw new Error("other Slack connection missing");

  // Every Organisation that a scheduled run reaches holds a published policy.
  const otherOrganisation = await requireActiveOrganisationActor({
    env,
    organisationId: OTHER_ORGANISATION_ID,
    now,
  });
  await otherOrganisation.ensureOrganisation({
    organisationId: OTHER_ORGANISATION_ID,
    name: "Other E2E Slack organisation",
    plan: "beta",
    status: "active",
    createdAt: now - 700,
  });
  const otherPolicy = await compilePublishAndActivateOrganisationPolicy({
    bindings: {
      db: organisationDatabase(OTHER_ORGANISATION_ID),
      kv: env.POLICY_KV,
    },
    organisationId: OTHER_ORGANISATION_ID,
    organisation: otherOrganisation,
    now,
  });
  if (!otherPolicy.ok) throw new Error(otherPolicy.error.code);

  const dropbox = await createActiveConnectedIntegration(fixtureDatabase(), {
    organisationId: ORGANISATION_ID,
    provider: "dropbox",
    providerSubjectId: "dbid:e2e-discovery",
    environment: "development",
    authMode: "api_key",
    authority: {
      kind: "connection_credential",
      credentialRef: requiredVaultHandle("vault:dropbox:e2e-discovery"),
    },
    grantedScopes: ["files.metadata.read"],
    createdByUserId: owner,
    providerAccountId: "provider-account-dropbox-secret",
    accountKind: "account",
    displayName: "Supplier Dropbox",
    capabilities: ["file.read"],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now: now - 500,
  });
  await createActiveConnectedIntegration(fixtureDatabase(), {
    organisationId: ORGANISATION_ID,
    provider: "gmail",
    providerSubjectId: "gmail:e2e-discovery",
    environment: "development",
    authMode: "api_key",
    authority: {
      kind: "connection_credential",
      credentialRef: requiredVaultHandle("vault:gmail:e2e-discovery"),
    },
    grantedScopes: ["mail.metadata"],
    createdByUserId: owner,
    providerAccountId: "provider-account-gmail-secret",
    accountKind: "mailbox",
    displayName: "Support Gmail",
    capabilities: [],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now: now - 400,
  });
  await createActiveConnectedIntegration(fixtureDatabase(), {
    organisationId: ORGANISATION_ID,
    provider: "stripe",
    providerSubjectId: "stripe:e2e-discovery",
    environment: "development",
    authMode: "api_key",
    authority: {
      kind: "connection_credential",
      credentialRef: requiredVaultHandle("vault:stripe:e2e-discovery"),
    },
    grantedScopes: ["read_only"],
    createdByUserId: owner,
    providerAccountId: "provider-account-stripe-secret",
    accountKind: "account",
    displayName: "Cafe Stripe",
    capabilities: [],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now: now - 300,
  });

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO app_user (
         user_id, issuer, subject, email, display_name,
         email_verified, created_at, last_authenticated_at
       ) VALUES (
         'user_d6293f8a-ff0d-5c41-b17d-2d9a9c87727f', 'https://accounts.google.com', 'e2e-revoked',
         'e2e-revoked@example.invalid', 'Revoked E2E User', 1, ?, ?
       )`,
    ).bind(now - 200, now - 200),
  ]);
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        `INSERT INTO external_identity_link (
         organisation_id, workspace_connection_id, workspace_id, external_user_id,
         user_id, verified_at, verified_by
       ) VALUES (?, ?, ?, ?, 'user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab', ?, 'google')`,
      )
      .bind(
        OTHER_ORGANISATION_ID,
        otherConnection.providerConnectionId,
        OTHER_WORKSPACE_ID,
        USER_ID,
        now - 200,
      ),
    fixtureDatabase()
      .prepare(
        `INSERT INTO person (organisation_id, person_id, display_name)
       VALUES (?, 'person_e2e-revoked', 'Revoked E2E User')`,
      )
      .bind(ORGANISATION_ID),
    fixtureDatabase()
      .prepare(
        `INSERT INTO service_role_grant (
         organisation_id, user_id, person_id, role, status, created_at, revoked_at
       ) VALUES (
         ?, 'user_d6293f8a-ff0d-5c41-b17d-2d9a9c87727f', 'person_e2e-revoked',
         'operator', 'revoked', ?, ?
       )`,
      )
      .bind(ORGANISATION_ID, now - 200, now - 100),
    fixtureDatabase()
      .prepare(
        `INSERT INTO external_identity_link (
         organisation_id, workspace_connection_id, workspace_id, external_user_id,
         user_id, verified_at, verified_by
       ) VALUES (?, ?, ?, ?, 'user_d6293f8a-ff0d-5c41-b17d-2d9a9c87727f', ?, 'google')`,
      )
      .bind(
        ORGANISATION_ID,
        base.selectedConnectionId,
        WORKSPACE_ID,
        REVOKED_USER_ID,
        now - 100,
      ),
  ]);

  await createRequiredGrant({
    grantId: DISCOVERY_GRANT_ID,
    subject: {
      kind: "conversation",
      integrationAccountId: base.selectedIntegrationAccountId,
      conversationId: CHANNEL_ID,
    },
    target: {
      kind: "platform_capability",
      capabilityId: CAPABILITY_KEYS.integrationDiscoveryRead,
      capabilityVersion: 1,
    },
    now: now - 100,
  });
  await createRequiredGrant({
    grantId: "grant_e2e_supplier_file",
    subject: {
      kind: "conversation",
      integrationAccountId: base.selectedIntegrationAccountId,
      conversationId: CHANNEL_ID,
    },
    target: {
      kind: "file_resource",
      capabilityId: CAPABILITY_KEYS.fileRead,
      capabilityVersion: 1,
      integrationAccountId: dropbox.account.integrationAccountId,
      scope: {
        kind: "dropbox_file",
        providerFileId: "id:supplier-contract",
        pathDisplay: "/Contracts/Supplier contract.txt",
      },
    },
    now: now - 100,
  });
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now,
  });
  const published = await compilePublishAndActivateOrganisationPolicy({
    bindings: { db: fixtureDatabase(), kv: env.POLICY_KV },
    organisationId: ORGANISATION_ID,
    organisation,
    now,
  });
  if (!published.ok) throw new Error(published.error.code);
  expect(published.value.snapshot.authz.allowedTools).toEqual(
    expect.arrayContaining([
      CAPABILITY_KEYS.integrationDiscoveryRead,
      CAPABILITY_KEYS.fileRead,
    ]),
  );
  await replaceFileGrantAdmissions({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    grantId: "grant_e2e_supplier_file",
    grantRevision: 1,
    admissions: [
      {
        grantId: "grant_e2e_supplier_file",
        grantRevision: 1,
        integrationAccountId: dropbox.account.integrationAccountId,
        provider: "dropbox",
        providerFileId: "id:supplier-contract",
        containingScopeKey: "dropbox_file:id:supplier-contract",
        providerRevision: { kind: "dropbox", rev: "e2e-1" },
      },
    ],
    admittedAt: now,
  });
  const scope = await requireOrganisationExecutionScope(env, ORGANISATION_ID);
  const sourceReader = new DiscoveryFileProjectionReader();
  const metadata = await sourceReader.readMetadata();
  const source = await upsertFileResourceSource({
    scope,
    metadata: {
      integrationAccountId: dropbox.account.integrationAccountId,
      provider: "dropbox",
      providerFileId: "id:supplier-contract",
      providerRevision: metadata.value.providerRevision,
      displayName: metadata.value.displayName,
      displayPath: metadata.value.displayPath,
      mediaType: metadata.value.mediaType,
      deepLink: metadata.value.deepLink,
      observedAt: now,
    },
    now,
  });
  if (!source.ok) throw new Error(source.error.code);
  const projected = await applyFileProjectionCommand({
    scope,
    command: createFileProjectionCommand({
      organisationId: ORGANISATION_ID,
      grantId: "grant_e2e_supplier_file",
      grantRevision: 1,
      integrationAccountId: dropbox.account.integrationAccountId,
      provider: "dropbox",
      providerFileId: "id:supplier-contract",
      sourceSequence: source.value.sourceSequence,
      providerRevision: { kind: "dropbox", rev: "e2e-1" },
      visibilityKey: encodeContextVisibility({
        kind: "conversation",
        integrationAccountId: base.selectedIntegrationAccountId,
        conversationId: CHANNEL_ID,
      }),
    }),
    sourceReader,
    now,
  });
  expect(projected, JSON.stringify(projected)).toEqual({
    kind: "applied",
    segmentCount: 1,
  });
  return {
    selectedIntegrationAccountId: base.selectedIntegrationAccountId,
    otherIntegrationAccountId: otherInstall.integrationAccountId,
    ownerSession: base.ownerSession,
  };
}

export async function createRequiredGrant(
  input: Readonly<{
    grantId: string;
    subject: Parameters<typeof createAccessGrant>[0]["subject"];
    target: Parameters<typeof createAccessGrant>[0]["target"];
    now: number;
  }>,
): Promise<void> {
  const created = await createAccessGrant({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    grantId: input.grantId,
    subject: input.subject,
    target: input.target,
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: `receipt_${input.grantId}`,
    },
    now: input.now,
  });
  if (!created.ok) throw new Error(created.error.code);
}

class DiscoveryFileProjectionReader implements FileProjectionSourceReader {
  readMetadata(): Promise<{
    readonly ok: true;
    readonly value: {
      readonly displayName: string;
      readonly displayPath: string;
      readonly mediaType: string;
      readonly deepLink: string;
      readonly sourceBytes: number;
      readonly providerRevision: {
        readonly kind: "dropbox";
        readonly rev: string;
      };
      readonly extraction: { readonly kind: "text" };
    };
  }> {
    return Promise.resolve({
      ok: true,
      value: {
        displayName: "Supplier contract.txt",
        displayPath: "/Contracts/Supplier contract.txt",
        mediaType: "text/plain",
        deepLink:
          "https://www.dropbox.com/home/Contracts/Supplier-contract.txt",
        sourceBytes: 32,
        providerRevision: { kind: "dropbox", rev: "e2e-1" },
        extraction: { kind: "text" },
      },
    });
  }

  readTextContent(): Promise<{
    readonly ok: true;
    readonly value: Uint8Array;
  }> {
    return Promise.resolve({
      ok: true,
      value: new TextEncoder().encode(
        "Supplier contract for flour deliveries.",
      ),
    });
  }
}

export function modelSimulator(): {
  readonly handler: ReturnType<typeof http.post>;
  readonly rootStarted: PromiseWithResolvers<void>;
  readonly releaseRoot: PromiseWithResolvers<void>;
  readonly requests: Record<string, unknown>[];
  readonly sessionIds: (string | null)[];
} {
  const rootStarted = Promise.withResolvers<void>();
  const releaseRoot = Promise.withResolvers<void>();
  const requests: Record<string, unknown>[] = [];
  const sessionIds: (string | null)[] = [];
  return {
    rootStarted,
    releaseRoot,
    requests,
    sessionIds,
    handler: http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      respondToModel.bind(null, rootStarted, releaseRoot, requests, sessionIds),
    ),
  };
}

async function respondToModel(
  rootStarted: PromiseWithResolvers<void>,
  releaseRoot: PromiseWithResolvers<void>,
  requests: Record<string, unknown>[],
  sessionIds: (string | null)[],
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  expect(request.headers.get("authorization")).toBe(
    `Bearer ${env.OPENROUTER_API_KEY}`,
  );
  const body = await request.json();
  if (!isRecord(body)) throw new Error("OpenRouter request body is invalid");
  requests.push(body);
  sessionIds.push(request.headers.get("x-session-id"));
  switch (requests.length) {
    case 1:
      rootStarted.resolve(undefined);
      await releaseRoot.promise;
      return openRouterText("Case work accepted.", "chatcmpl_e2e_root");
    case 2:
      return openRouterText("Follow-up completed.", "chatcmpl_e2e_followup");
    default:
      throw new Error("Unexpected additional OpenRouter request");
  }
}

/** A model that answers each request, and records its Session header. */
export function replyingModel(): {
  readonly handler: ReturnType<typeof http.post>;
  readonly sessionIds: (string | null)[];
  readonly requests: number;
} {
  const sessionIds: (string | null)[] = [];
  return {
    sessionIds,
    get requests() {
      return sessionIds.length;
    },
    handler: http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      replyToModel.bind(null, sessionIds),
    ),
  };
}

async function replyToModel(
  sessionIds: (string | null)[],
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  await request.json();
  sessionIds.push(request.headers.get("x-session-id"));
  return openRouterText(
    `Reply ${String(sessionIds.length)}.`,
    `chatcmpl_55e_${String(sessionIds.length)}`,
  );
}

export function discoveryModelSimulator(): {
  readonly handler: ReturnType<typeof http.post>;
  readonly requests: Record<string, unknown>[];
  readonly requestCount: () => number;
} {
  const requests: Record<string, unknown>[] = [];
  return {
    requests,
    requestCount: countMessages.bind(null, requests),
    handler: http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      async function respondToDiscoveryModel({ request }) {
        expect(request.headers.get("authorization")).toBe(
          `Bearer ${env.OPENROUTER_API_KEY}`,
        );
        const body = await request.json();
        if (!isRecord(body))
          throw new Error("OpenRouter discovery request body is invalid");
        requests.push(body);
        switch (requests.length) {
          case 1:
            // The catalog is small, so the first request offers every tool
            // and the model needs no search step.
            expect(offeredToolNames(body)).toEqual(
              expect.arrayContaining([
                "codemode",
                "file_search",
                "integration_list",
                "tool_search",
              ]),
            );
            return openRouterToolCall(
              "integration_list",
              {},
              "tool_e2e_integration_list",
            );
          case 2: {
            const output = requireLastToolOutput(body);
            expect(output).toContain("integration_ref_");
            expect(output).toContain("configuredDataClasses");
            expect(output).toContain("readableDataClasses");
            expect(output).toContain("files");
            expect(output).not.toContain("provider-account-dropbox-secret");
            expect(output).not.toContain("provider-account-gmail-secret");
            expect(output).not.toContain("provider-account-stripe-secret");
            expect(output).not.toContain("vault:");
            return openRouterText(
              "Connected: Dropbox, Gmail, Slack, and Stripe. Only Dropbox files are readable here.",
              "chatcmpl_e2e_discovery",
            );
          }
          case 3:
            return openRouterToolCall(
              "file_search",
              { query: "supplier contract", limit: 5 },
              "tool_e2e_file_search",
            );
          case 4:
            expect(requireLastToolOutput(body)).toContain(
              "Supplier contract.txt",
            );
            return openRouterText(
              "The separately granted file is Supplier contract.txt.",
              "chatcmpl_e2e_file_followup",
            );
          case 5: {
            const requestBody = JSON.stringify(body);
            expect(requestBody).not.toContain("integration_list");
            return openRouterText(
              requestBody.includes(DISCOVERY_ANSWER)
                ? DISCOVERY_ANSWER
                : DISCOVERY_UNAVAILABLE,
              "chatcmpl_e2e_discovery_revoked",
            );
          }
          default:
            throw new Error("Unexpected additional discovery model request");
        }
      },
    ),
  };
}

/** The names of the tools that one model request offers, in order. */
export function offeredToolNames(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.tools)) return [];
  return body.tools.map(offeredToolName).sort();
}

function offeredToolName(tool: unknown): string {
  if (
    !isRecord(tool) ||
    !isRecord(tool.function) ||
    typeof tool.function.name !== "string"
  )
    throw new Error("OpenRouter tool is invalid");
  return tool.function.name;
}

export function requireLastToolOutput(body: Record<string, unknown>): string {
  if (!Array.isArray(body.messages))
    throw new Error("OpenRouter messages missing");
  for (let index = body.messages.length - 1; index >= 0; index -= 1) {
    const message = body.messages[index];
    if (isRecord(message) && message.role === "tool")
      return JSON.stringify(message.content);
  }
  throw new Error("OpenRouter tool output missing");
}

/** A user message of a model request that holds this text. */
export function userMessageContaining(text: string, message: unknown): boolean {
  return (
    isRecord(message) &&
    message.role === "user" &&
    JSON.stringify(message.content).includes(text)
  );
}

/** A user message that is this text alone, as history holds a message. */
export function userMessageIs(text: string, message: unknown): boolean {
  if (!isRecord(message) || message.role !== "user") return false;
  const content = message.content;
  return (
    content === text ||
    (Array.isArray(content) &&
      content.length === 1 &&
      isRecord(content[0]) &&
      content[0].text === text)
  );
}

/**
 * A streamed answer is one message in the thread: the start creates it, and
 * each append and the stop add their text to it.
 */
function streamToSlack(
  messages: Record<string, string>[],
  method: string,
  raw: unknown,
): Record<string, unknown> {
  if (!isRecord(raw) || typeof raw.channel !== "string")
    throw new Error("Slack stream body is invalid");
  const text = typeof raw.markdown_text === "string" ? raw.markdown_text : "";
  if (method === "chat.startStream") {
    if (typeof raw.thread_ts !== "string")
      throw new Error("Slack stream body is invalid");
    const ts = `1787500001.${String(messages.length + 1).padStart(6, "0")}`;
    messages.push({ channel: raw.channel, thread_ts: raw.thread_ts, text, ts });
    return { ok: true, ts };
  }
  const message = messages.find((entry) => entry.ts === raw.ts);
  if (message === undefined) return { ok: false, error: "message_not_found" };
  message.text += text;
  return { ok: true, ts: message.ts };
}

/** Whether a Slack message is a commerce card that waits for its decision. */
export function isApprovalCard(message: Record<string, string>): boolean {
  return (
    message.text?.includes(
      "Nothing changes until an owner or admin approves it",
    ) === true
  );
}

/** The action ids of a Slack message's buttons, in their order. */
export function cardButtons(
  message: Record<string, string> | undefined,
): readonly string[] {
  const blocks: unknown = JSON.parse(message?.blocks ?? "[]");
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((block: unknown) =>
    isRecord(block) && Array.isArray(block.elements)
      ? block.elements.flatMap((element: unknown) =>
          isRecord(element) && typeof element.action_id === "string"
            ? [element.action_id]
            : [],
        )
      : [],
  );
}

/**
 * A post as the thread shows it. Pantry posts a model answer as Markdown
 * (`markdown_text`) and a notice as plain text (`text`); the record holds the
 * shown text as `text` either way.
 */
export function shownSlackPost(
  body: Record<string, string>,
): Record<string, string> {
  const { markdown_text: markdown, ...plain } = body;
  return markdown === undefined ? body : { ...plain, text: markdown };
}

export function slackSimulator(
  allowedTokens: readonly string[] = [SLACK_BOT_TOKEN],
): {
  readonly handler: ReturnType<typeof http.post>;
  readonly messages: Record<string, string>[];
  readonly statuses: Record<string, string>[];
  readonly visibleMessageCount: () => number;
  readonly visibleStatusCount: () => number;
  /**
   * The posts that let Slack fetch their links for a preview. A link in an
   * answer must not be fetched with no click (Plan 89 step 6).
   */
  readonly postsWithLinkPreview: () => number;
} {
  const messages: Record<string, string>[] = [];
  const statuses: Record<string, string>[] = [];
  const previews = { posts: 0 };
  return {
    messages,
    statuses,
    postsWithLinkPreview: () => previews.posts,
    visibleMessageCount: countMessages.bind(null, messages),
    visibleStatusCount: countMessages.bind(null, statuses),
    handler: http.post(
      "https://slack.com/api/:method",
      async function respondToSlack({ params, request }) {
        expect(allowedTokens).toContain(
          request.headers.get("authorization")?.replace(/^Bearer /u, ""),
        );
        if (params.method === "assistant.threads.setStatus") {
          const body = await request.json();
          if (!isStringRecord(body))
            throw new Error("Slack status body is invalid");
          statuses.push(body);
          return HttpResponse.json({ ok: true });
        }
        if (
          params.method === "chat.startStream" ||
          params.method === "chat.appendStream" ||
          params.method === "chat.stopStream"
        )
          return HttpResponse.json(
            streamToSlack(
              messages,
              String(params.method),
              await request.json(),
            ),
          );
        if (params.method === "chat.update") {
          const update = await request.json();
          if (!isRecord(update) || !Array.isArray(update.blocks))
            throw new Error("Slack update body is invalid");
          const message = messages.find((entry) => entry.ts === update.ts);
          if (message === undefined)
            return HttpResponse.json({ ok: false, error: "message_not_found" });
          message.text = String(update.text);
          message.blocks = JSON.stringify(update.blocks);
          return HttpResponse.json({ ok: true, ts: update.ts });
        }
        if (params.method !== "chat.postMessage") {
          throw new Error(`Unexpected Slack method: ${String(params.method)}`);
        }
        const posted: unknown = await request.json();
        // The preview flags are booleans. They are counted, not kept.
        const { unfurl_links, unfurl_media, ...raw } = isRecord(posted)
          ? posted
          : { unfurl_links: undefined, unfurl_media: undefined };
        if (unfurl_links !== false || unfurl_media !== false)
          previews.posts += 1;
        // A card's blocks are kept as their JSON, beside its fallback text.
        const body = Array.isArray(raw.blocks)
          ? { ...raw, blocks: JSON.stringify(raw.blocks) }
          : raw;
        if (!isStringRecord(body))
          throw new Error("Slack message body is invalid");
        const ts = `1787500001.${String(messages.length + 1).padStart(6, "0")}`;
        messages.push({ ...shownSlackPost(body), ts });
        return HttpResponse.json({ ok: true, channel: body.channel, ts });
      },
    ),
  };
}

function countMessages(messages: readonly unknown[]): number {
  return messages.length;
}

/**
 * A Slack API that accepts the bot token and records the time of each
 * `chat.postMessage`.
 */
export async function respondToSlack(
  posts: number[],
  { params, request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  if (request.headers.get("authorization") !== `Bearer ${SLACK_BOT_TOKEN}`)
    return HttpResponse.json({ ok: false, error: "invalid_auth" });
  const body: unknown = slackPostFields(await request.json());
  if (!isStringRecord(body)) throw new Error("Slack request body is invalid");
  if (params.method === "chat.postMessage") {
    posts.push(Date.now());
    return HttpResponse.json({
      ok: true,
      channel: body.channel,
      ts: "1787500001.000001",
    });
  }
  return HttpResponse.json({ ok: true });
}

/** The deliveries that settled on one Slack message. */
export async function receiptsOfMessage(
  connectorId: string,
  ts: string,
): Promise<number> {
  const { connector } = await inspectSlackActors(connectorId);
  if (!connector.ok) throw new Error(connector.error.code);
  return connector.value.receipts.filter(
    (receipt) => receipt.nativeReceiptId === ts,
  ).length;
}

export async function inspectSlackActors(connectorId: string) {
  const rows = await fixtureDatabase()
    .prepare(
      `SELECT object_kind AS objectKind,
            logical_object_id AS logicalObjectId,
            physical_object_name AS physicalObjectName
     FROM durable_object_registry
     WHERE organisation_id = ? AND lifecycle_status = 'active'`,
    )
    .bind(ORGANISATION_ID)
    .all<{
      readonly objectKind: string;
      readonly logicalObjectId: string;
      readonly physicalObjectName: string;
    }>();
  const connectorRow = rows.results.find(
    (row) =>
      row.objectKind === "connector" && row.logicalObjectId === connectorId,
  );
  const caseRows = rows.results.filter((row) => row.objectKind === "case");
  const sessionRows = rows.results.filter(
    (row) => row.objectKind === "session",
  );
  const caseRow = caseRows[0];
  const sessionRow = sessionRows[0];
  if (
    connectorRow === undefined ||
    caseRow === undefined ||
    sessionRow === undefined ||
    caseRows.length !== 1 ||
    sessionRows.length !== 1
  ) {
    throw new Error("E2E Slack actors are missing");
  }
  const sessionId = requiredSessionId(sessionRow.logicalObjectId);
  return {
    connector: await env.CONNECTOR.getByName(
      connectorRow.physicalObjectName,
    ).inspect(),
    case: await env.CASE.getByName(caseRow.physicalObjectName).inspect(),
    session: await env.SESSION.getByName(
      sessionRow.physicalObjectName,
    ).inspectCanonicalSessionState({
      organisationId: ORGANISATION_ID,
      sessionId,
    }),
    sessionId,
  };
}

/**
 * The token usage that OpenRouter reports in the last chunk of a stream.
 * `prompt_tokens` includes the cached tokens.
 */
export type OpenRouterUsage = Readonly<{
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: Readonly<{ cached_tokens: number }>;
}>;

/** The usage of one model call: `prompt` input tokens, `cached` of them from the cache. */
export function openRouterUsage(
  prompt: number,
  cached: number,
  completion: number,
): OpenRouterUsage {
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: cached },
  };
}

export function openRouterText(
  text: string,
  id: string,
  usage: OpenRouterUsage = {
    prompt_tokens: 20,
    completion_tokens: 5,
    total_tokens: 25,
  },
): Response {
  return openRouterStream([
    {
      id,
      object: "chat.completion.chunk",
      created: 1_787_500_000,
      model: PLATFORM_DEFAULT_PI_MODEL,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: text },
          finish_reason: null,
        },
      ],
    },
    {
      id,
      object: "chat.completion.chunk",
      created: 1_787_500_000,
      model: PLATFORM_DEFAULT_PI_MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage,
    },
  ]);
}

export function openRouterToolCall(
  name: string,
  args: Readonly<Record<string, unknown>>,
  callId: string,
  usage?: OpenRouterUsage,
): Response {
  return openRouterStream([
    {
      id: `chatcmpl_${callId}`,
      object: "chat.completion.chunk",
      created: 1_787_500_000,
      model: PLATFORM_DEFAULT_PI_MODEL,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: callId,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: `chatcmpl_${callId}`,
      object: "chat.completion.chunk",
      created: 1_787_500_000,
      model: PLATFORM_DEFAULT_PI_MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      ...(usage === undefined ? {} : { usage }),
    },
  ]);
}

export function openRouterStream(
  chunks: readonly Record<string, unknown>[],
): Response {
  const body =
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
    "data: [DONE]\n\n";
  return new HttpResponse(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

export function slackEnvelope(input: {
  readonly eventType: "app_mention" | "message";
  readonly eventId: string;
  readonly messageTs: string;
  readonly threadTs: string;
  readonly text: string;
  readonly subtype?: string;
  readonly files?: readonly Record<string, unknown>[];
  readonly blocks?: readonly Record<string, unknown>[];
}): Record<string, unknown> {
  return slackEnvelopeFor({
    workspaceId: WORKSPACE_ID,
    channelId: CHANNEL_ID,
    userId: USER_ID,
    ...input,
  });
}

export function slackEnvelopeFor(input: {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly userId: string;
  readonly eventType: "app_mention" | "message";
  readonly eventId: string;
  readonly messageTs: string;
  readonly threadTs: string;
  readonly text: string;
  readonly subtype?: string;
  readonly files?: readonly Record<string, unknown>[];
  readonly blocks?: readonly Record<string, unknown>[];
}): Record<string, unknown> {
  return {
    type: "event_callback",
    api_app_id: "A12345678",
    event_id: input.eventId,
    team_id: input.workspaceId,
    event: {
      type: input.eventType,
      channel: input.channelId,
      user: input.userId,
      text: input.text,
      ts: input.messageTs,
      thread_ts: input.threadTs,
      event_ts: input.messageTs,
      ...(input.subtype === undefined ? {} : { subtype: input.subtype }),
      ...(input.files === undefined ? {} : { files: input.files }),
      ...(input.blocks === undefined ? {} : { blocks: input.blocks }),
    },
  };
}

/**
 * Serves the Slack file endpoints an attachment journey needs: `files.info`
 * metadata and the private download host.
 */
export function slackFileSimulator(
  files: readonly {
    readonly id: string;
    readonly name: string;
    readonly mimetype: string;
    readonly bytes: Uint8Array;
  }[],
): {
  readonly infoHandler: ReturnType<typeof http.get>;
  readonly downloadHandler: ReturnType<typeof http.get>;
  readonly downloads: string[];
} {
  const downloads: string[] = [];

  return {
    downloads,
    infoHandler: http.get(
      "https://slack.com/api/files.info",
      function respondToFileInfo({ request }) {
        const fileId = new URL(request.url).searchParams.get("file");
        const file = files.find(function byId(candidate) {
          return candidate.id === fileId;
        });

        if (file === undefined) {
          return HttpResponse.json({ ok: false, error: "file_not_found" });
        }

        return HttpResponse.json({
          ok: true,
          file: {
            id: file.id,
            name: file.name,
            mimetype: file.mimetype,
            size: file.bytes.byteLength,
            url_private_download: `https://files.slack.com/files-pri/${file.id}/download`,
          },
        });
      },
    ),
    downloadHandler: http.get(
      "https://files.slack.com/files-pri/:fileId/download",
      function respondToDownload({ params }) {
        const file = files.find(function byId(candidate) {
          return candidate.id === params.fileId;
        });

        if (file === undefined) {
          return new HttpResponse(null, { status: 404 });
        }

        downloads.push(String(params.fileId));

        return new HttpResponse(file.bytes.slice() as unknown as BodyInit, {
          status: 200,
          headers: {
            "content-type": file.mimetype,
            "content-length": String(file.bytes.byteLength),
          },
        });
      },
    ),
  };
}

export function readSlackMessageText(message: Record<string, string>): string {
  return message.text ?? "";
}

/** The texts of the posts in this thread of the journey's channel. */
export function threadAnswers(
  messages: readonly Record<string, string>[],
  threadTs: string,
): string[] {
  return messages
    .filter(
      (message) =>
        message.channel === CHANNEL_ID && message.thread_ts === threadTs,
    )
    .map(readSlackMessageText);
}

/** The thread and the text of a Slack post. */
export function threadAndText(post: Record<string, string>): {
  readonly thread: string | undefined;
  readonly text: string | undefined;
} {
  return { thread: post.thread_ts, text: post.text };
}

/** Slack sends a mention that starts the thread at `ts`. */
export async function postMention(
  eventId: string,
  ts: string,
  question: string,
): Promise<void> {
  const response = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId,
        messageTs: ts,
        threadTs: ts,
        text: `<@U0PANTRY> ${question}`,
      }),
    ),
  );
  expect(response.status).toBe(200);
}

/**
 * Slack sends a message in the thread of `ROOT_TS`: a mention when it starts
 * the thread, a reply after that.
 */
export async function sendSlack(
  eventId: string,
  messageTs: string,
  text: string,
): Promise<void> {
  const response = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: messageTs === ROOT_TS ? "app_mention" : "message",
        eventId,
        messageTs,
        threadTs: ROOT_TS,
        text,
      }),
    ),
  );
  expect(response.status).toBe(200);
}

/** Slack sends the event, and the ingress gives it to a Case. */
export async function acceptSlack(
  envelope: Parameters<typeof slackEnvelope>[0],
): Promise<void> {
  const response = await exports.default.fetch(
    await signedSlackRequest(slackEnvelope(envelope)),
  );
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(isRecord(body) ? body.durableMode : null).toBe("case_accepted");
}

export async function signedSlackRequest(
  envelope: Record<string, unknown>,
): Promise<Request> {
  const rawBody = JSON.stringify(envelope);
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SLACK_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${rawBody}`),
  );
  return new Request("http://pantry.test/slack/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${hex(new Uint8Array(digest))}`,
    },
    body: rawBody,
  });
}

export function hex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

function requiredOrganisationId(raw: string) {
  const parsed = parseOrganisationId(raw);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

export function requiredWorkspaceId(raw: string) {
  const parsed = parseWorkspaceId(raw);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

export function requiredUserId(raw: string) {
  const parsed = parseUserId(raw);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

export function requiredSessionId(raw: string) {
  const parsed = parseSessionId(raw);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

export function requiredVaultHandle(raw: string) {
  const parsed = parseVaultHandle(raw);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

export function requiredPlacement() {
  const parsed = parseInitialOrganisationPlacement({
    kind: "affinity",
    placementEpoch: 1,
    placementCellId: "e2e",
    locationHint: "wnam",
  });
  if (!parsed.ok) throw new Error(parsed.error.path);
  return parsed.value;
}

/**
 * A Slack post as a journey's fake reads it: its text fields. The two flags
 * that refuse a link preview are booleans, and each post of Pantry carries
 * them (Plan 89 step 6), so they are left out here.
 */
export function slackPostFields(posted: unknown): unknown {
  if (!isRecord(posted)) return posted;
  const { unfurl_links: _links, unfurl_media: _media, ...fields } = posted;
  return fields;
}

export function isStringRecord(
  value: unknown,
): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

export function settledReceiptIdentities(snapshot: CaseSnapshot) {
  const identities = [];
  for (const output of snapshot.outputs) {
    if (output.kind !== "settled")
      throw new Error("E2E Slack Case output is pending");
    identities.push(receiptIdentity(output.receipt));
  }
  return identities;
}

export function receiptIdentity(receipt: ConnectorDeliveryReceipt) {
  return {
    deliveryId: receipt.deliveryId,
    connectorId: receipt.connectorId,
    idempotencyKey: receipt.idempotencyKey,
    nativeReceiptId: receipt.nativeReceiptId,
    deliveredAt: receipt.deliveredAt,
  };
}
