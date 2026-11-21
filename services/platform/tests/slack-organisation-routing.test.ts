import type { SingleDatabase } from "../src/database-handles";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
import { describe, expect, it } from "vitest";

import { createOrganisationInstall } from "../src/data/organisation";
import { parseVaultHandle } from "../src/credential-vault/domain";
import {
  parseCaseId,
  parseChannelId,
  parseIntegrationAccountId,
  parseSlackAppId,
  parseSlackInstallationId,
  parseSlackOrganisationConnectionId,
  parseOrganisationId,
  parseWorkspaceId,
  type CaseId,
  type ChannelId,
  type IntegrationAccountId,
  type SlackAppId,
  type SlackInstallationId,
  type SlackOrganisationConnectionId,
  type OrganisationId,
  type WorkspaceId,
} from "../src/ids";
import { parseUserId, type UserId } from "@purin-labs/control-api/ids";
import { parseSlackUserId } from "../src/slack/events";
import { parseInitialOrganisationPlacement } from "../src/placement";
import {
  resolveOrClaimSlackThreadRoute,
  selectSlackDmOrganisation,
} from "../src/slack/organisation-routing";
import {
  configureSlackChannelDefault,
  userMayDisconnectSlackInstallation,
  createSlackInstallation,
  createSlackOrganisationConnection,
  disconnectSlackInstallation,
  listSlackOrganisationRouting,
} from "../src/slack/installation-store";
import { createMigratedDatabase } from "./sqlite-d1";
import "./provide-organisation-lifecycle-parts";

const APP_ID = requiredSlackAppId("A_PLAN25B");
const INSTALLATION_ID = requiredInstallationId("slack_installation_plan25b");
const WORKSPACE_ID = requiredWorkspaceId("T_PLAN25B");
const ORGANISATION_A = requiredOrganisationId("organisation_plan25b_a");
const ORGANISATION_B = requiredOrganisationId("organisation_plan25b_b");
const CONNECTION_A = requiredConnectionId("slack_connection_plan25b_a");
const CONNECTION_B = requiredConnectionId("slack_connection_plan25b_b");
const CHANNEL = requiredChannelId("C_PLAN25B");
const OTHER_CHANNEL = requiredChannelId("C_PLAN25B_OTHER");
const DM_CHANNEL = requiredChannelId("D_PLAN25B");
const CONTROL_A = requiredControlId(
  "user_7ec9cce0-e60b-5956-a024-83ca6b616dfa",
);
const CONTROL_B = requiredControlId(
  "user_a20be2d1-b695-5656-8424-39c8a73ea16e",
);
const CASE_A = requiredCaseId("case_plan25b_a");
const CASE_B = requiredCaseId("case_plan25b_b");
const BOT_TOKEN_REF = requiredVaultHandle("vault:slack:bot:plan25b");
const SLACK_USER = requiredSlackUserId("U0PLAN25B");

describe("Plan 25B Slack organisation routing", function plan25bRoutingSuite() {
  it(
    "pins old threads while a changed channel default routes new roots",
    preservesPinnedOrganisation,
  );
  it("fails closed for unbound channels and disabled connections", failsClosed);
  it(
    "requires an authorised DM selection and preserves existing pins",
    routesDmSelection,
  );
  it(
    "requires authority across organisations for installation-wide disconnect",
    disconnectsInstallation,
  );
});

async function disconnectsInstallation(): Promise<void> {
  const fixture = await createFixture();
  await expect(
    userMayDisconnectSlackInstallation(
      {
        DB: fixture.db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      {
        userId: CONTROL_A,
        installationId: INSTALLATION_ID,
      },
    ),
  ).resolves.toBe(false);
  await fixture.db.batch([
    fixture.db
      .prepare(
        `INSERT INTO person (organisation_id, person_id, display_name)
         VALUES (?, 'person_shared_admin', 'Shared administrator')`,
      )
      .bind(ORGANISATION_B),
    fixture.db
      .prepare(
        `INSERT INTO service_role_grant (
           organisation_id, user_id, person_id, role, status,
           created_at, revoked_at
         ) VALUES (?, ?, 'person_shared_admin', 'admin', 'active', 20, NULL)`,
      )
      .bind(ORGANISATION_B, CONTROL_A),
  ]);
  await expect(
    userMayDisconnectSlackInstallation(
      {
        DB: fixture.db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      {
        userId: CONTROL_A,
        installationId: INSTALLATION_ID,
      },
    ),
  ).resolves.toBe(true);
  await expect(
    disconnectSlackInstallation({
      env: {
        DB: fixture.db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      installationId: INSTALLATION_ID,
      disconnectedAt: 300,
    }),
  ).resolves.toEqual({
    ok: true,
    value: { disconnectedConnectionCount: 2 },
  });
  const state = await fixture.db
    .prepare(
      `SELECT installation.lifecycle AS installationLifecycle,
              secret.revoked_at AS secretRevokedAt,
              SUM(CASE WHEN connection.lifecycle = 'revoked' THEN 1 ELSE 0 END)
                AS revokedConnections
       FROM slack_installation AS installation
       JOIN slack_organisation_connection AS connection
         ON connection.installation_id = installation.installation_id
       JOIN vault_secret AS secret
         ON secret.organisation_id = installation.credential_organisation_id
        AND secret.vault_handle = installation.bot_token_ref
       WHERE installation.installation_id = ?`,
    )
    .bind(INSTALLATION_ID)
    .first();
  expect(state).toMatchObject({
    installationLifecycle: "revoked",
    secretRevokedAt: 300,
    revokedConnections: 2,
  });
}

async function routesDmSelection(): Promise<void> {
  const fixture = await createFixture();
  await expect(
    claimDmRoot(fixture.db, "1789300000.000020", CASE_B),
  ).resolves.toEqual({ kind: "unbound" });
  await expect(
    selectSlackDmOrganisation(
      {
        DB: fixture.db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      {
        installationId: INSTALLATION_ID,
        destinationConnectionId: CONNECTION_B,
        destinationOrganisationId: ORGANISATION_B,
        userId: CONTROL_B,
        selectedAt: 100,
      },
    ),
  ).resolves.toEqual({
    ok: true,
    value: { revision: 1, externalUserId: SLACK_USER },
  });
  await expect(
    selectSlackDmOrganisation(
      {
        DB: fixture.db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      {
        installationId: INSTALLATION_ID,
        destinationConnectionId: CONNECTION_B,
        destinationOrganisationId: ORGANISATION_B,
        userId: CONTROL_B,
        selectedAt: 101,
      },
    ),
  ).resolves.toEqual({
    ok: true,
    value: { revision: 1, externalUserId: SLACK_USER },
  });
  await expect(
    claimDmRoot(fixture.db, "1789300000.000020", CASE_B),
  ).resolves.toMatchObject({
    kind: "resolved",
    value: {
      organisationId: ORGANISATION_B,
      routingSource: { kind: "dm_selection", revision: 1 },
    },
  });
  await selectSlackDmOrganisation(
    {
      DB: fixture.db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE:
        TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    {
      installationId: INSTALLATION_ID,
      destinationConnectionId: CONNECTION_A,
      destinationOrganisationId: ORGANISATION_A,
      userId: CONTROL_A,
      selectedAt: 200,
    },
  );
  await expect(
    resolveOrClaimSlackThreadRoute(fixture.db, {
      kind: "reply",
      environment: "development",
      appId: APP_ID,
      workspaceId: WORKSPACE_ID,
      channelId: DM_CHANNEL,
      rootMessageTs: "1789300000.000020",
    }),
  ).resolves.toMatchObject({
    kind: "resolved",
    value: { organisationId: ORGANISATION_B, caseId: CASE_B },
  });
  await expect(
    claimDmRoot(fixture.db, "1789300000.000021", CASE_A),
  ).resolves.toMatchObject({
    kind: "resolved",
    value: {
      organisationId: ORGANISATION_A,
      routingSource: { kind: "dm_selection", revision: 2 },
    },
  });
}

async function preservesPinnedOrganisation(): Promise<void> {
  const fixture = await createFixture();
  const initial = await configureSlackChannelDefault(fixture.db, {
    kind: "bind_unbound",
    installationId: INSTALLATION_ID,
    channelId: CHANNEL,
    destinationConnectionId: CONNECTION_A,
    destinationOrganisationId: ORGANISATION_A,
    boundByUserId: CONTROL_A,
    changedAt: 100,
  });
  expect(initial).toMatchObject({
    ok: true,
    value: { organisationId: ORGANISATION_A, revision: 1 },
  });

  const duplicateClaims = await Promise.all([
    claimRoot(fixture.db, "1789300000.000001", CASE_A),
    claimRoot(fixture.db, "1789300000.000001", CASE_A),
  ]);
  expect(duplicateClaims).toEqual([
    expect.objectContaining({ kind: "resolved" }),
    expect.objectContaining({ kind: "resolved" }),
  ]);
  expect(duplicateClaims[0]).toEqual(duplicateClaims[1]);
  expect(duplicateClaims[0]).toMatchObject({
    value: {
      organisationId: ORGANISATION_A,
      connectionId: CONNECTION_A,
      routingSource: { kind: "channel_default", revision: 1 },
    },
  });

  const changed = await configureSlackChannelDefault(fixture.db, {
    kind: "replace",
    installationId: INSTALLATION_ID,
    channelId: CHANNEL,
    expectedRevision: 1,
    sourceOrganisationId: ORGANISATION_A,
    destinationConnectionId: CONNECTION_B,
    destinationOrganisationId: ORGANISATION_B,
    boundByUserId: CONTROL_B,
    changedAt: 200,
  });
  expect(changed).toMatchObject({
    ok: true,
    value: { organisationId: ORGANISATION_B, revision: 2 },
  });
  await expect(
    listSlackOrganisationRouting(fixture.db, ORGANISATION_A),
  ).resolves.toMatchObject([
    { connectionId: CONNECTION_A, channelDefaults: [] },
  ]);
  await expect(
    listSlackOrganisationRouting(fixture.db, ORGANISATION_B),
  ).resolves.toMatchObject([
    {
      connectionId: CONNECTION_B,
      channelDefaults: [{ channelId: CHANNEL, revision: 2 }],
    },
  ]);

  await expect(
    resolveOrClaimSlackThreadRoute(fixture.db, {
      kind: "reply",
      environment: "development",
      appId: APP_ID,
      workspaceId: WORKSPACE_ID,
      channelId: CHANNEL,
      rootMessageTs: "1789300000.000001",
    }),
  ).resolves.toMatchObject({
    kind: "resolved",
    value: {
      organisationId: ORGANISATION_A,
      caseId: CASE_A,
      routingSource: { kind: "channel_default", revision: 1 },
    },
  });
  await expect(
    claimRoot(fixture.db, "1789300000.000002", CASE_B),
  ).resolves.toMatchObject({
    kind: "resolved",
    value: {
      organisationId: ORGANISATION_B,
      caseId: CASE_B,
      routingSource: { kind: "channel_default", revision: 2 },
    },
  });
}

async function failsClosed(): Promise<void> {
  const fixture = await createFixture();
  await expect(
    resolveOrClaimSlackThreadRoute(fixture.db, {
      kind: "root",
      environment: "development",
      appId: APP_ID,
      workspaceId: WORKSPACE_ID,
      channelId: OTHER_CHANNEL,
      rootMessageTs: "1789300000.000010",
      caseId: CASE_A,
      occurredAt: 100,
      externalUserId: SLACK_USER,
    }),
  ).resolves.toEqual({ kind: "unbound" });

  await configureSlackChannelDefault(fixture.db, {
    kind: "bind_unbound",
    installationId: INSTALLATION_ID,
    channelId: CHANNEL,
    destinationConnectionId: CONNECTION_B,
    destinationOrganisationId: ORGANISATION_B,
    boundByUserId: CONTROL_B,
    changedAt: 100,
  });
  await fixture.db
    .prepare(
      `UPDATE slack_organisation_connection
       SET lifecycle = 'disabled', revision = revision + 1,
           updated_at = 200, disabled_at = 200
       WHERE connection_id = ?`,
    )
    .bind(CONNECTION_B)
    .run();
  await expect(
    claimRoot(fixture.db, "1789300000.000011", CASE_B),
  ).resolves.toEqual({
    kind: "disabled",
    boundary: "organisation_connection",
  });
}

async function createFixture(): Promise<{
  readonly db: SingleDatabase;
  readonly accountA: IntegrationAccountId;
  readonly accountB: IntegrationAccountId;
}> {
  const db = createMigratedDatabase();
  const accountA = await createOrganisation(
    db,
    ORGANISATION_A,
    WORKSPACE_ID,
    1,
  );
  const organisationBWorkspace = requiredWorkspaceId("T_PLAN25B_FIXTURE_B");
  const accountB = await createOrganisation(
    db,
    ORGANISATION_B,
    organisationBWorkspace,
    2,
  );
  await db
    .prepare(
      `UPDATE integration_account SET provider_account_id = ?
       WHERE integration_account_id = ? AND organisation_id = ?`,
    )
    .bind(WORKSPACE_ID, accountB, ORGANISATION_B)
    .run();
  await db
    .prepare(
      `UPDATE surface_installation SET workspace_id = ?
       WHERE integration_account_id = ? AND organisation_id = ?`,
    )
    .bind(WORKSPACE_ID, accountB, ORGANISATION_B)
    .run();
  await seedSlackIdentityLink(db, ORGANISATION_A, accountA, CONTROL_A);
  await seedSlackIdentityLink(db, ORGANISATION_B, accountB, CONTROL_B);
  await seedVaultSecret(db, ORGANISATION_A);
  await createSlackInstallation(db, {
    installationId: INSTALLATION_ID,
    environment: "development",
    appId: APP_ID,
    workspaceId: WORKSPACE_ID,
    credentialOrganisationId: ORGANISATION_A,
    botTokenRef: BOT_TOKEN_REF,
    installModel: "unlisted",
    scopes: ["app_mentions:read", "chat:write"],
    installedAt: 10,
  });
  await createSlackOrganisationConnection(
    {
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE:
        TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    {
      connectionId: CONNECTION_A,
      installationId: INSTALLATION_ID,
      organisationId: ORGANISATION_A,
      integrationAccountId: accountA,
      connectedAt: 20,
    },
  );
  await createSlackOrganisationConnection(
    {
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE:
        TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    {
      connectionId: CONNECTION_B,
      installationId: INSTALLATION_ID,
      organisationId: ORGANISATION_B,
      integrationAccountId: accountB,
      connectedAt: 30,
    },
  );
  return { db, accountA, accountB };
}

async function createOrganisation(
  db: SingleDatabase,
  organisationId: OrganisationId,
  workspaceId: WorkspaceId,
  now: number,
): Promise<IntegrationAccountId> {
  const record = await createOrganisationInstall(db, db, {
    organisationId,
    name: organisationId,
    surfaceKind: "slack",
    workspaceId,
    installModel: "unlisted",
    botTokenRef: `vault:slack:bot:${workspaceId.toLowerCase()}`,
    scopes: ["app_mentions:read", "chat:write"],
    placement: requiredPlacement(),
    createdAt: now,
    installedAt: now,
  });
  return requiredIntegrationAccountId(record.integrationAccountId);
}

async function seedVaultSecret(
  db: SingleDatabase,
  organisationId: OrganisationId,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO vault_secret (
         organisation_id, vault_handle, key_version, algorithm, nonce_b64,
         ciphertext_b64, created_at, rotated_at, revoked_at
       ) VALUES (?, 'vault:slack:bot:plan25b', 'v1', 'AES-GCM-256',
                 'nonce', 'ciphertext', 10, NULL, NULL)`,
    )
    .bind(organisationId)
    .run();
}

function claimRoot(db: SingleDatabase, rootMessageTs: string, caseId: CaseId) {
  return resolveOrClaimSlackThreadRoute(db, {
    kind: "root",
    environment: "development",
    appId: APP_ID,
    workspaceId: WORKSPACE_ID,
    channelId: CHANNEL,
    rootMessageTs,
    caseId,
    occurredAt: 100,
    externalUserId: SLACK_USER,
  });
}

function claimDmRoot(
  db: SingleDatabase,
  rootMessageTs: string,
  caseId: CaseId,
) {
  return resolveOrClaimSlackThreadRoute(db, {
    kind: "root",
    environment: "development",
    appId: APP_ID,
    workspaceId: WORKSPACE_ID,
    channelId: DM_CHANNEL,
    rootMessageTs,
    caseId,
    occurredAt: 100,
    externalUserId: SLACK_USER,
  });
}

async function seedSlackIdentityLink(
  db: SingleDatabase,
  organisationId: OrganisationId,
  integrationAccountId: IntegrationAccountId,
  userId: UserId,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO app_user (user_id, issuer, subject, email, display_name, email_verified, created_at, last_authenticated_at) VALUES (?, 'urn:pantry:fixture', ?, ?, 'Operator', 0, 1, 1)`,
    )
    .bind(userId, userId, `${userId}@example.test`)
    .run();
  const connection = await db
    .prepare(
      `SELECT provider_connection_id AS providerConnectionId
       FROM integration_account
       WHERE integration_account_id = ? AND organisation_id = ?`,
    )
    .bind(integrationAccountId, organisationId)
    .first<{ readonly providerConnectionId: string }>();
  if (connection === null)
    throw new Error("fixture provider connection missing");
  const personId = `person_${organisationId}`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO person (organisation_id, person_id, display_name)
         VALUES (?, ?, 'Plan 25B operator')`,
      )
      .bind(organisationId, personId),
    db
      .prepare(
        `INSERT INTO service_role_grant (
           organisation_id, user_id, person_id, role, status,
           created_at, revoked_at
         ) VALUES (?, ?, ?, 'admin', 'active', 10, NULL)`,
      )
      .bind(organisationId, userId, personId),
  ]);
  await db
    .prepare(
      `INSERT INTO external_identity_link (
         organisation_id, workspace_connection_id, workspace_id, external_user_id,
         user_id, verified_at, verified_by
       ) VALUES (?, ?, ?, ?, ?, 10, 'seams')`,
    )
    .bind(
      organisationId,
      connection.providerConnectionId,
      WORKSPACE_ID,
      SLACK_USER,
      userId,
    )
    .run();
}

function requiredPlacement() {
  const parsed = parseInitialOrganisationPlacement({
    kind: "affinity",
    placementEpoch: 1,
    placementCellId: "multi-region-preview",
    locationHint: "wnam",
  });
  if (!parsed.ok) throw new Error("placement fixture invalid");
  return parsed.value;
}

function requiredOrganisationId(value: string): OrganisationId {
  return required(value, parseOrganisationId);
}

function requiredWorkspaceId(value: string): WorkspaceId {
  return required(value, parseWorkspaceId);
}

function requiredChannelId(value: string): ChannelId {
  return required(value, parseChannelId);
}

function requiredCaseId(value: string): CaseId {
  return required(value, parseCaseId);
}

function requiredControlId(value: string): UserId {
  return required(value, parseUserId);
}

function requiredIntegrationAccountId(value: string): IntegrationAccountId {
  return required(value, parseIntegrationAccountId);
}

function requiredSlackAppId(value: string): SlackAppId {
  return required(value, parseSlackAppId);
}

function requiredInstallationId(value: string): SlackInstallationId {
  return required(value, parseSlackInstallationId);
}

function requiredConnectionId(value: string): SlackOrganisationConnectionId {
  return required(value, parseSlackOrganisationConnectionId);
}

function requiredVaultHandle(value: string) {
  return required(value, parseVaultHandle);
}

function requiredSlackUserId(value: string) {
  const parsed = parseSlackUserId(value, "fixture.externalUserId");
  if (!parsed.ok) throw new Error(`invalid fixture identity: ${value}`);
  return parsed.value;
}

function required<T>(
  value: string,
  parser: (
    raw: string,
  ) => { readonly ok: true; readonly value: T } | { readonly ok: false },
): T {
  const parsed = parser(value);
  if (!parsed.ok) throw new Error(`invalid fixture identity: ${value}`);
  return parsed.value;
}
