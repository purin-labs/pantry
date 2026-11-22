/// <reference types="@cloudflare/workers-types" />

import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { describe, expect, it, vi, type TestContext } from "vitest";

import { parseVaultHandle, storeVaultSecret } from "../src/credential-vault";
import { testRoot } from "./secrets-store";
import { CONNECTOR_ACTOR_SCHEMA_VERSION } from "@purin-labs/actor-runtime/actors/actor-schema-versions";
import type {
  ActorActivationRequest,
  ActorActivationResult,
} from "@purin-labs/actor-runtime/actors/actor-registry";
import { issueControlSession, upsertUser } from "@purin-labs/tenancy/data/control-plane";
import { createOrganisationInstall } from "@purin-labs/tenancy/data/organisation";
import { parseSlackAppId, type OrganisationId } from "@purin-labs/kernel/ids";
import { parseSlackEnvelope } from "../src/slack/events";
import {
  authorizeResolvedSlackCaseIngress,
  resolveSlackCaseIngressRoute,
} from "../src/slack/ingress-admission";
import { activateActorFixture } from "./organisation-execution-fixture";
import {
  TEST_INITIAL_ORGANISATION_PLACEMENT,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
import { createMigratedDatabase } from "./sqlite-d1";
import { requireOrganisationId, requireWorkspaceId } from "./test-ids";
import { platformEnv } from "./worker-fakes";
import "./provide-organisation-lifecycle-parts";

const NOW = 1_785_810_000_100;

describe("Slack ingress admission", slackIngressAdmissionSuite);

function slackIngressAdmissionSuite(): void {
  it(
    "resolves an authorized root mention and Connector route at the captured placement",
    resolvesAuthorizedRoot,
  );
  it(
    "admits the first command before its Connector registry entry exists",
    admitsFirstConnectorCommand,
  );
  it(
    "rejects ingress outside the organisation's selected Slack destination",
    rejectsUnselectedDestination,
  );
  it(
    "rejects ingress for a suspended organisation",
    rejectsSuspendedOrganisation,
  );
  it(
    "rejects a mismatched Slack app before installation lookup",
    rejectsMismatchedApp,
  );
}

async function rejectsMismatchedApp(): Promise<void> {
  const appId = parseSlackAppId("A_OTHER_APP");
  if (!appId.ok) throw new Error("Slack app fixture invalid");
  const prepare = vi.fn();
  const admission = await resolveSlackCaseIngressRoute({
    db: {
      prepare,
      withSession: vi.fn().mockReturnThis(),
    } as unknown as SingleDatabase,
    event: rootMention(),
    occurredAt: NOW,
    installationIdentity: {
      environment: "development",
      appId: appId.value,
    },
  });
  expect(admission).toEqual({ kind: "rejected", reason: "install_inactive" });
  expect(prepare).not.toHaveBeenCalled();
}

async function resolvesAuthorizedRoot(context: TestContext): Promise<void> {
  const fixture = await createFixture();
  const connectorId = `connector_slack_${fixture.integrationAccountId}`;
  const identities = await ingressFor(fixture);
  if (identities.admission.kind !== "authorized")
    throw new Error(
      `Slack fixture admission failed: ${JSON.stringify(identities.admission)}`,
    );
  await activateActorFixture(
    fixture.env,
    { activate: activateConnector },
    {
      objectKind: "connector",
      organisationId: fixture.organisationId,
      logicalObjectId: identities.admission.value.connectorId,
    },
    CONNECTOR_ACTOR_SCHEMA_VERSION,
  );
  const { admission, slackCredential } = await ingressFor(fixture);
  expect(admission).toMatchObject({
    kind: "authorized",
    value: {
      installationId: "slack_installation_latency_test",
      organisationConnectionId: "slack_connection_latency_test",
      organisationId: fixture.organisationId,
      integrationAccountId: fixture.integrationAccountId,
      userId: fixture.operator.user.userId,
      principalId: "person_latency-operator",
      membershipRole: "operator",
      connectorId,
      caseId: "case_slack_T0LATENCY_C0LATENCY_1785810000_000001",
      sessionId: "session_case_slack_T0LATENCY_C0LATENCY_1785810000_000001",
      placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    },
  });
  await expect(slackCredential).resolves.toEqual({
    kind: "unavailable",
    reason: "credential_inactive",
  });
  Object.assign(context.task.meta, {
    slackAdmission: {
      organisationId: fixture.organisationId,
      integrationAccountId: fixture.integrationAccountId,
      nativeRole: "operator",
      connectorRegistered: true,
      credentialReleased: false,
    },
  });
}

async function admitsFirstConnectorCommand(): Promise<void> {
  const fixture = await createFixture();
  const connector = await fixture.db
    .prepare(
      "SELECT 1 AS present FROM durable_object_registry WHERE organisation_id = ? AND object_kind = 'connector'",
    )
    .bind(fixture.organisationId)
    .first();
  expect(connector).toBeNull();
  const { admission } = await ingressFor(fixture);
  expect(admission).toMatchObject({
    kind: "authorized",
    value: {
      organisationId: fixture.organisationId,
      connectorId: `connector_slack_${fixture.integrationAccountId}`,
    },
  });
}

async function rejectsSuspendedOrganisation(): Promise<void> {
  const fixture = await createFixture();
  await fixture.db
    .prepare(
      "UPDATE organisation SET status = 'suspended' WHERE organisation_id = ?",
    )
    .bind(fixture.organisationId)
    .run();
  const { admission } = await ingressFor(fixture);
  expect(admission).toEqual({
    kind: "rejected",
    reason: "organisation_inactive",
  });
}

async function rejectsUnselectedDestination(): Promise<void> {
  const fixture = await createFixture();
  await fixture.db
    .prepare("DELETE FROM organisation_slack_channel WHERE organisation_id = ?")
    .bind(fixture.organisationId)
    .run();
  const { admission } = await ingressFor(fixture);
  expect(admission).toEqual({
    kind: "rejected",
    reason: "destination_missing",
  });
}

async function ingressFor(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return authorizeResolvedSlackCaseIngress({
    env: fixture.env,
    keys: { PANTRY_VAULT_ACTIVE_KEY_VERSION: "v1" },
    event: rootMention(),
    route: fixture.route,
  });
}

async function activateConnector(
  request: ActorActivationRequest,
): Promise<ActorActivationResult> {
  return {
    ok: true,
    value: {
      kind: "activated",
      registryId: request.registryId,
      stateVersion: 1,
    },
  };
}

async function createFixture() {
  const db = createMigratedDatabase();
  const organisationId = requireOrganisationId("organisation_latency_test");
  const install = await createOrganisationInstall(db, db, {
    organisationId,
    name: "Slack admission",
    surfaceKind: "slack",
    workspaceId: requireWorkspaceId("T0LATENCY"),
    installModel: "unlisted",
    botTokenRef: "vault:slack:bot:t0latency",
    scopes: ["app_mentions:read", "chat:write"],
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    createdAt: 1,
    installedAt: 1,
  });
  const connection = await db
    .prepare(
      "SELECT provider_connection_id AS providerConnectionId FROM integration_account WHERE integration_account_id = ?",
    )
    .bind(install.integrationAccountId)
    .first<{ providerConnectionId: string }>();
  if (connection === null) throw new Error("Slack provider connection missing");
  const handle = parseVaultHandle("vault:slack:bot:t0latency");
  if (!handle.ok) throw new Error(handle.error.code);
  const stored = await storeVaultSecret({
    db,
    keys: { PANTRY_VAULT_ACTIVE_KEY_VERSION: "v1", VAULT_ROOT_V1: testRoot(24) },
    organisationId,
    handle: handle.value,
    secret: { kind: "bearer", value: "xoxb-latency-fixture" },
    now: 1,
  });
  if (!stored.ok) throw new Error(stored.error.code);
  await db
    .prepare(
      "UPDATE vault_secret SET revoked_at = 2 WHERE organisation_id = ? AND vault_handle = ?",
    )
    .bind(organisationId, handle.value)
    .run();
  const owner = await createGoogleMember(db, organisationId, "owner");
  const operator = await createGoogleMember(db, organisationId, "operator");
  await db.batch([
    db
      .prepare(
        `INSERT INTO slack_installation (installation_id, environment, app_id, workspace_id, credential_organisation_id, bot_token_ref, install_model, scopes_json, lifecycle, installed_at, updated_at) VALUES ('slack_installation_latency_test', 'development', 'A_PLAN25B', 'T0LATENCY', ?, 'vault:slack:bot:t0latency', 'unlisted', '["app_mentions:read","chat:write"]', 'active', 1, 1)`,
      )
      .bind(organisationId),
    db
      .prepare(
        `INSERT INTO slack_organisation_connection (connection_id, installation_id, organisation_id, integration_account_id, lifecycle, revision, connected_at, updated_at) VALUES ('slack_connection_latency_test', 'slack_installation_latency_test', ?, ?, 'active', 1, 1, 1)`,
      )
      .bind(organisationId, install.integrationAccountId),
    db
      .prepare(
        `INSERT INTO slack_channel_default (installation_id, channel_id, connection_id, revision, bound_by_user_id, bound_at) VALUES ('slack_installation_latency_test', 'C0LATENCY', 'slack_connection_latency_test', 1, ?, 1)`,
      )
      .bind(owner.user.userId),
    db
      .prepare(
        `INSERT INTO organisation_communication_destination (organisation_id, integration_account_id, workspace_id, channel_id, provider_revision, selected_at) VALUES (?, ?, 'T0LATENCY', 'C0LATENCY', 'channel-latency-1', 1)`,
      )
      .bind(organisationId, install.integrationAccountId),
    db
      .prepare(
        `INSERT INTO organisation_slack_channel (organisation_id, integration_account_id, workspace_id, channel_id, provider_revision, connected_at) VALUES (?, ?, 'T0LATENCY', 'C0LATENCY', 'channel-latency-1', 1)`,
      )
      .bind(organisationId, install.integrationAccountId),
    db
      .prepare(
        `INSERT INTO external_identity_link (organisation_id, workspace_connection_id, workspace_id, external_user_id, user_id, verified_at, verified_by) VALUES (?, ?, 'T0LATENCY', 'U0LATENCY', ?, 1, 'google')`,
      )
      .bind(
        organisationId,
        connection.providerConnectionId,
        operator.user.userId,
      ),
  ]);
  const testEnv = platformEnv({
    DB: db,
    PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
  });
  const event = rootMention();
  const routed = await resolveSlackCaseIngressRoute({
    db,
    event,
    occurredAt: NOW,
    installationIdentity: { environment: "development", appId: event.appId },
  });
  if (routed.kind !== "routed")
    throw new Error(`Slack route fixture failed: ${JSON.stringify(routed)}`);
  return {
    db,
    env: testEnv,
    organisationId,
    integrationAccountId: install.integrationAccountId,
    operator,
    route: routed.route,
  };
}

async function createGoogleMember(
  db: SingleDatabase,
  organisationId: OrganisationId,
  role: "owner" | "operator",
) {
  const now = Date.now();
  const user = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: `slack-latency-${role}`,
      email: `slack-latency-${role}@example.test`,
      displayName: `Slack latency ${role}`,
      emailVerified: true,
    },
    now,
  });
  const personId = `person_latency-${role}`;
  await db.batch([
    db
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
      )
      .bind(organisationId, personId, user.displayName),
    db
      .prepare(
        "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at) VALUES (?, ?, ?, ?, 'active', ?, NULL)",
      )
      .bind(organisationId, user.userId, personId, role, now),
  ]);
  const issued = await issueControlSession({
    db,
    userId: user.userId,
    now,
    ttlMs: 3600000,
  });
  return { user, session: issued.session };
}

function rootMention() {
  const parsed = parseSlackEnvelope(
    JSON.stringify({
      type: "event_callback",
      api_app_id: "A_PLAN25B",
      event_id: "Ev0LATENCY",
      team_id: "T0LATENCY",
      event: {
        type: "app_mention",
        channel: "C0LATENCY",
        user: "U0LATENCY",
        text: "<@U0PANTRY> respond",
        ts: "1785810000.000001",
        event_ts: "1785810000.000001",
      },
    }),
  );
  if (!parsed.ok || parsed.value.kind !== "message")
    throw new Error("Slack fixture invalid");
  return parsed.value.event;
}
