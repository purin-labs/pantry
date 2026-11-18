import type { SingleDatabase } from "../src/database-handles";
import { requireOrganisationBootstrap } from "./organisation-execution-fixture";
/// <reference types="@cloudflare/workers-types" />

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { ConnectorDO } from "../src/actors/connector";
import { upsertUser } from "../src/data/control-plane";
import {
  connectionCredentialAuthority,
  createConnectedIntegration,
  setIntegrationAccountLifecycle,
  upsertSurfaceInstallation,
  type ConnectedIntegrationSeed,
} from "../src/data/integration-account";
import { storeVaultSecret, type VaultHandle } from "../src/credential-vault";
import type {
  UserId,
  IntegrationAccountId,
  ProviderConnectionId,
  SlackInstallationId,
  OrganisationId,
} from "../src/ids";
import {
  newSlackInstallationId,
  newSlackOrganisationConnectionId,
  parseChannelId,
  parseSlackAppId,
  parseWorkspaceId,
} from "../src/ids";
import {
  activateSlackInstallation,
  configureSlackChannelDefault,
  createSlackInstallation,
  createSlackOrganisationConnection,
} from "../src/slack/organisation-routing";
import { organisationBootstrapMutation } from "./control-mutation-fixture";
import {
  TEST_INITIAL_ORGANISATION_PLACEMENT,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
import { activateConnectorFixture } from "./fixtures/connector-activation";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import { testRoot } from "./secrets-store";
import { requireConnectorId, requireVaultHandle } from "./test-ids";
import { createMigratedDatabase } from "./sqlite-d1";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";

const NOW = 1_786_380_000_000;
const WORKSPACE_ID = "T0PLAN19ROTATE";
const CHANNEL_ID = "C0PLAN19ROTATE";
const SLACK_REQUESTS: RequestInit[] = [];

describe(
  "Plan 19 Slack credential rotation",
  plan19SlackCredentialRotationSuite,
);

function plan19SlackCredentialRotationSuite(): void {
  it(
    "delivers to the selected destination through the rotated workspace credential",
    deliversSelectedDestinationAfterRotation,
  );
}

async function deliversSelectedDestinationAfterRotation(): Promise<void> {
  SLACK_REQUESTS.length = 0;
  vi.stubGlobal("fetch", slackFetch);
  const fixture = await createRotationFixture();
  const destinationBefore = await readDestination(
    fixture.db,
    fixture.organisationId,
  );

  const rotated = await rotateSlackCredential(fixture);
  const destinationAfter = await readDestination(
    fixture.db,
    fixture.organisationId,
  );

  expect(rotated.account.integrationAccountId).toBe(
    fixture.integrationAccountId,
  );
  expect(rotated.connection.providerConnectionId).toBe(
    fixture.providerConnectionId,
  );
  expect(
    connectionCredentialAuthority(rotated.connection.authority)
      ?.credentialGeneration,
  ).toBe(2);
  expect(destinationAfter).toEqual(destinationBefore);
  expect(destinationAfter).toEqual({
    integrationAccountId: fixture.integrationAccountId,
    workspaceId: WORKSPACE_ID,
    channelId: CHANNEL_ID,
    providerRevision: "slack-channel-selected-1",
  });

  const actor = await connectorActor(
    platformEnv({
      DB: fixture.db,
      SATYR_DEPLOYMENT_PROFILE: "local",
      SLACK_APP_ID: "A_PLAN19_ROTATE",
      SATYR_VAULT_ACTIVE_KEY_VERSION: "v1",
      VAULT_ROOT_V1: fixture.root,
      SATYR_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    }),
    fixture.organisationId,
  );
  const delivered = await actor.deliver(
    deliveryRequest(fixture.organisationId),
  );
  if (delivered.ok && delivered.value.kind === "rejected") {
    throw new Error(delivered.value.reason);
  }

  expect(delivered).toMatchObject({
    ok: true,
    value: {
      kind: "delivered",
      receipt: { nativeReceiptId: "1786380000.000777" },
    },
  });
  expect(SLACK_REQUESTS).toHaveLength(1);
  expect(SLACK_REQUESTS[0]?.headers).toMatchObject({
    authorization: "Bearer xoxb-plan19-rotated",
  });
  expect(JSON.parse(String(SLACK_REQUESTS[0]?.body))).toMatchObject({
    channel: CHANNEL_ID,
    markdown_text: "Inventory is low.",
  });
  await expect(
    readCredentialGenerations(fixture.db, fixture.providerConnectionId),
  ).resolves.toEqual([
    { generation: 1, lifecycle: "superseded" },
    { generation: 2, lifecycle: "active" },
  ]);
  await expect(
    actor.deliver(deliveryRequest(fixture.organisationId)),
  ).resolves.toMatchObject({
    ok: true,
    value: { kind: "already_delivered" },
  });
  expect(SLACK_REQUESTS).toHaveLength(1);
}

type RotationFixture = {
  readonly db: SingleDatabase;
  readonly root: SecretsStoreSecret;
  readonly organisationId: OrganisationId;
  readonly ownerUserId: UserId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly providerConnectionId: ProviderConnectionId;
  readonly installationId: SlackInstallationId;
  readonly oldHandle: VaultHandle;
  readonly newHandle: VaultHandle;
};

async function createRotationFixture(): Promise<RotationFixture> {
  const db = createMigratedDatabase();
  const owner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "plan19-rotation-owner",
      email: "plan19-rotation@example.com",
      displayName: "Plan 19 Rotation Owner",
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
    organisationName: "Plan 19 Rotation",
    environment: "development",
    mutation: organisationBootstrapMutation(owner, NOW),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: NOW,
  });
  await activateOnboarding(db, organisation.organisationId);
  const root = testRoot(19);
  const keys = {
    SATYR_VAULT_ACTIVE_KEY_VERSION: "v1" as const,
    VAULT_ROOT_V1: root,
  };
  const oldHandle = requireVaultHandle(
    "vault:organisation:slack:t0plan19rotate:oauth:g1",
  );
  const newHandle = requireVaultHandle(
    "vault:organisation:slack:t0plan19rotate:oauth:g2",
  );
  await storeBearer(
    db,
    keys,
    organisation.organisationId,
    oldHandle,
    "xoxb-plan19-original",
    NOW,
  );
  const connected = await createConnectedIntegration(
    db,
    slackSeed(organisation.organisationId, owner.userId, oldHandle, NOW),
  );
  const activated = await setIntegrationAccountLifecycle({
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    lifecycle: { kind: "active" },
    now: NOW,
  });
  if (!activated.ok) throw new Error(activated.error.code);
  await upsertSurfaceInstallation({
    db,
    account: activated.value,
    surfaceKind: "slack",
    workspaceId: WORKSPACE_ID,
    installModel: "unlisted",
    botTokenRef: oldHandle,
    scopes: ["channels:read", "chat:write"],
    installedAt: NOW,
  });
  const installationId = newSlackInstallationId();
  const connectionId = newSlackOrganisationConnectionId();
  const appId = requiredSlackAppId();
  const workspaceId = requiredWorkspaceId();
  const channelId = requiredChannelId();
  await createSlackInstallation(db, {
    installationId,
    environment: "development",
    appId,
    workspaceId,
    credentialOrganisationId: organisation.organisationId,
    botTokenRef: oldHandle,
    installModel: "unlisted",
    scopes: ["channels:read", "chat:write"],
    installedAt: NOW,
  });
  await createSlackOrganisationConnection(
    {
      DB: db,
      SATYR_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    {
      connectionId,
      installationId,
      organisationId: organisation.organisationId,
      integrationAccountId: activated.value.integrationAccountId,
      connectedAt: NOW,
    },
  );
  const channelDefault = await configureSlackChannelDefault(db, {
    kind: "bind_unbound",
    installationId,
    channelId,
    destinationConnectionId: connectionId,
    destinationOrganisationId: organisation.organisationId,
    boundByUserId: owner.userId,
    changedAt: NOW,
  });
  if (!channelDefault.ok) throw new Error(channelDefault.error.code);
  await seedDestination(
    db,
    organisation.organisationId,
    connected.account.integrationAccountId,
  );
  await storeBearer(
    db,
    keys,
    organisation.organisationId,
    newHandle,
    "xoxb-plan19-rotated",
    NOW + 1,
  );
  return {
    db,
    root,
    organisationId: organisation.organisationId,
    ownerUserId: owner.userId,
    integrationAccountId: connected.account.integrationAccountId,
    providerConnectionId: connected.connection.providerConnectionId,
    installationId,
    oldHandle,
    newHandle,
  };
}

async function rotateSlackCredential(
  fixture: RotationFixture,
): Promise<Awaited<ReturnType<typeof createConnectedIntegration>>> {
  const rotated = await createConnectedIntegration(
    fixture.db,
    slackSeed(
      fixture.organisationId,
      fixture.ownerUserId,
      fixture.newHandle,
      NOW + 1,
    ),
  );
  await upsertSurfaceInstallation({
    db: fixture.db,
    account: rotated.account,
    surfaceKind: "slack",
    workspaceId: WORKSPACE_ID,
    installModel: "unlisted",
    botTokenRef: fixture.newHandle,
    scopes: ["channels:read", "chat:write"],
    installedAt: NOW + 1,
  });
  const activated = await activateSlackInstallation({
    db: fixture.db,
    installationId: fixture.installationId,
    credentialOrganisationId: fixture.organisationId,
    botTokenRef: fixture.newHandle,
    scopes: ["channels:read", "chat:write"],
    activatedAt: NOW + 1,
  });
  if (!activated) throw new Error("Slack installation rotation failed");
  return rotated;
}

function requiredSlackAppId() {
  const parsed = parseSlackAppId("A_PLAN19_ROTATE");
  if (!parsed.ok) throw new Error("Slack app fixture is invalid");
  return parsed.value;
}

function requiredWorkspaceId() {
  const parsed = parseWorkspaceId(WORKSPACE_ID);
  if (!parsed.ok) throw new Error("Slack workspace fixture is invalid");
  return parsed.value;
}

function requiredChannelId() {
  const parsed = parseChannelId(CHANNEL_ID);
  if (!parsed.ok) throw new Error("Slack channel fixture is invalid");
  return parsed.value;
}

function slackSeed(
  organisationId: OrganisationId,
  userId: UserId,
  credentialRef: VaultHandle,
  now: number,
): ConnectedIntegrationSeed {
  return {
    organisationId,
    provider: "slack",
    providerSubjectId: WORKSPACE_ID,
    environment: "development",
    authMode: "shared_satyr_app",
    authority: { kind: "connection_credential", credentialRef },
    grantedScopes: ["channels:read", "chat:write"],
    createdByUserId: userId,
    providerAccountId: WORKSPACE_ID,
    accountKind: "workspace",
    displayName: "Plan 19 workspace",
    capabilities: ["conversation.ingress", "conversation.egress"],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now,
  };
}

async function activateOnboarding(
  db: SingleDatabase,
  organisationId: OrganisationId,
): Promise<void> {
  await db
    .prepare(
      `UPDATE organisation_onboarding
     SET lifecycle = 'active', activation_receipt_id = 'activation_plan19_rotation',
         activated_at = ?, updated_at = ?
     WHERE organisation_id = ?`,
    )
    .bind(NOW, NOW, organisationId)
    .run();
}

async function seedDestination(
  db: SingleDatabase,
  organisationId: OrganisationId,
  integrationAccountId: IntegrationAccountId,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO organisation_communication_destination (
       organisation_id, integration_account_id, workspace_id, channel_id,
       provider_revision, selected_at
     ) VALUES (?, ?, ?, ?, 'slack-channel-selected-1', ?)`,
    )
    .bind(organisationId, integrationAccountId, WORKSPACE_ID, CHANNEL_ID, NOW)
    .run();
}

async function readDestination(
  db: SingleDatabase,
  organisationId: OrganisationId,
): Promise<{
  readonly integrationAccountId: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly providerRevision: string;
}> {
  const row = await db
    .prepare(
      `SELECT integration_account_id AS integrationAccountId,
            workspace_id AS workspaceId, channel_id AS channelId,
            provider_revision AS providerRevision
     FROM organisation_communication_destination WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<{
      readonly integrationAccountId: unknown;
      readonly workspaceId: unknown;
      readonly channelId: unknown;
      readonly providerRevision: unknown;
    }>();
  if (
    row === null ||
    typeof row.integrationAccountId !== "string" ||
    typeof row.workspaceId !== "string" ||
    typeof row.channelId !== "string" ||
    typeof row.providerRevision !== "string"
  ) {
    throw new Error("Plan 19 Slack destination is invalid");
  }
  return {
    integrationAccountId: row.integrationAccountId,
    workspaceId: row.workspaceId,
    channelId: row.channelId,
    providerRevision: row.providerRevision,
  };
}

async function readCredentialGenerations(
  db: SingleDatabase,
  providerConnectionId: ProviderConnectionId,
): Promise<
  readonly { readonly generation: number; readonly lifecycle: string }[]
> {
  const rows = await db
    .prepare(
      `SELECT credential_generation AS generation, lifecycle
     FROM provider_credential_generation
     WHERE provider_connection_id = ? ORDER BY credential_generation`,
    )
    .bind(providerConnectionId)
    .all<{ readonly generation: number; readonly lifecycle: string }>();
  return rows.results ?? [];
}

async function storeBearer(
  db: SingleDatabase,
  keys: {
    readonly SATYR_VAULT_ACTIVE_KEY_VERSION: "v1";
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
  if (!stored.ok) throw new Error(stored.error.code);
}

async function connectorActor(
  env: UnitTestEnv,
  organisationId: OrganisationId,
): Promise<ConnectorDO> {
  const fixture = emptySqliteFixture();
  const storage = new TestStorage(
    fixture.database,
    sqlStorage(fixture.storage),
  );
  const actor = new ConnectorDO(
    { storage } as unknown as DurableObjectState,
    env,
  );
  await activateConnectorFixture(
    actor,
    env,
    organisationId,
    requireConnectorId("connector_plan19_rotation"),
  );
  return actor;
}

function deliveryRequest(organisationId: OrganisationId): unknown {
  return {
    identity: { organisationId, connectorId: "connector_plan19_rotation" },
    delivery: {
      deliveryId: "delivery_plan19_rotation",
      bindingId: "binding_plan19_rotation",
      address: {
        kind: "slack_channel",
        workspaceId: WORKSPACE_ID,
        channelId: CHANNEL_ID,
      },
      caseId: "case_plan19_rotation",
      caseRevision: 1,
      content: { kind: "text", text: "Inventory is low." },
      idempotencyKey: "case_output_plan19_rotation",
      addressedAt: NOW + 2,
    },
    requestedAt: NOW + 2,
  };
}

async function slackFetch(
  _input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  SLACK_REQUESTS.push(init ?? {});
  return new Response(JSON.stringify({ ok: true, ts: "1786380000.000777" }), {
    status: 200,
  });
}

class TestStorage {
  constructor(
    private readonly database: DatabaseSync,
    readonly sql: SqlStorage,
  ) {}

  async setAlarm(): Promise<void> {}
  async deleteAlarm(): Promise<void> {}

  transactionSync<Value>(callback: () => Value): Value {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = callback();
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
