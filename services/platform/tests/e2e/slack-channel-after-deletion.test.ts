import { fixtureDatabase } from "./organisation-database";
import { env, exports } from "cloudflare:workers";
import { HttpResponse, http } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import {
  parseVaultHandle,
  storeVaultSecret,
  type VaultHandle,
} from "../../src/credential-vault";
import { newControlMutationIdentity } from "@purin-labs/tenancy/data/control-mutation";
import { listAccessGrants } from "../../src/data/access-grants";
import { createActiveConnectedIntegration } from "@purin-labs/connections/data/integration-account";
import {
  archiveOrganisation,
  deleteArchivedOrganisation,
  type ArchiveOrganisationMutation,
} from "@purin-labs/tenancy/data/organisation-lifecycle";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { runScheduledOnboardingReconciliation } from "../../src/onboarding-reconciliation-runner";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { commerceClient, commerceWorkspace } from "./commerce-support";
import { network } from "./network";
import { configurationVersion, readHeaders } from "./purge-support";
import { type OrganisationClient } from "./organisation-fixture";

declare module "vitest" {
  interface TaskMeta {
    slackChannelAfterDeletion?: Record<string, unknown>;
  }
}

const PUBLIC_ORIGIN = "https://localhost";
const APP_ID = "A12345678";
const TEAM_ID = "T0DELETED1";
const INSTALLATION_ID = "installation_e2e_after_deletion";
// The channel of the Organisation that its owner deletes.
const RELEASED_CHANNEL = "C0CAFEOPS1";
// The channel of an Organisation that still posts in the workspace.
const HELD_CHANNEL = "C0KITCHEN1";
const SLACK_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "channels:history",
  "channels:read",
  "files:read",
  "groups:history",
  "groups:read",
  "im:history",
] as const;

type Owner = Readonly<{
  client: OrganisationClient;
  organisationId: OrganisationId;
}>;

type RoutingConnection = Readonly<{
  installationId: string;
  connectionId: string;
  channels: readonly Readonly<{ channelId: string; revision: number }>[];
}>;

it(
  "lets a new Organisation take over the Slack workspace of a deleted one, recover its Slack account after a failed check, and not take the channel of an Organisation in use",
  slackChannelAfterDeletionJourney,
  120_000,
);

async function slackChannelAfterDeletionJourney({ task }: TestContext) {
  const checkedTokens: string[] = [];
  network.use(
    http.post("https://slack.com/api/auth.test", ({ request }) => {
      checkedTokens.push(
        (request.headers.get("authorization") ?? "").replace(/^Bearer /u, ""),
      );
      return HttpResponse.json({ ok: true, team_id: TEAM_ID });
    }),
    http.post("https://slack.com/api/oauth.v2.access", () =>
      HttpResponse.json({
        ok: true,
        app_id: APP_ID,
        access_token: "xoxb-after-deletion",
        scope: SLACK_SCOPES.join(","),
        bot_user_id: "U0PANTRYBOT",
        team: { id: TEAM_ID, name: "Cafe Workspace" },
      }),
    ),
    http.get("https://slack.com/api/conversations.list", () =>
      HttpResponse.json({
        ok: true,
        channels: [RELEASED_CHANNEL, HELD_CHANNEL].map(function channel(id) {
          return {
            id,
            name: id.toLowerCase(),
            is_private: false,
            is_member: true,
            updated: 17,
          };
        }),
        response_metadata: { next_cursor: "" },
      }),
    ),
  );

  // Two Organisations already share the workspace installation. The first
  // installed it and posts in one channel; the second posts in another.
  const deleted = await nativeOwner("deleted");
  const inUse = await nativeOwner("in-use");
  await seedWorkspace(deleted, inUse);

  // The first one's owner archives it; the scheduled cleanup revokes its
  // Slack connection; the owner deletes it.
  const archived = await archiveOrganisation({
    identityDatabase: env.DB,
    execution: await requireOrganisationExecutionScope(
      env,
      deleted.organisationId,
    ),
    actorUserId: deleted.client.identity.userId,
    authority: { kind: "organisation_owner" },
    reasonCode: "merchant_archived",
    now: Date.now(),
    mutation: await lifecycleMutation(deleted, "archive"),
  });
  if (!archived.ok) throw new Error(archived.error.code);
  await runScheduledOnboardingReconciliation(env, Date.now());
  expect(await connectionLifecycle(deleted.organisationId)).toBe("revoked");
  const removed = await deleteArchivedOrganisation({
    directory: env.DB,
    execution: await requireOrganisationExecutionScope(
      env,
      deleted.organisationId,
    ),
    actorUserId: deleted.client.identity.userId,
    now: Date.now(),
    mutation: await lifecycleMutation(deleted, "delete"),
  });
  if (!removed.ok) throw new Error(removed.error.code);

  // A new Organisation connects the same workspace in the Portal.
  const fresh = await nativeOwner("fresh");
  await connectSlack(fresh);
  const connection = await activeConnection(fresh);
  expect(connection.installationId).toBe(INSTALLATION_ID);

  // Later scheduled cleanup removes what the deleted Organisation still
  // holds. Then the owner opens the Portal, which checks the Slack
  // connection with Slack. It must stay usable, and Slack must see the token
  // that the new owner's consent issued.
  await runScheduledOnboardingReconciliation(env, Date.now());
  checkedTokens.length = 0;
  const readiness = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${fresh.organisationId}/readiness`,
    { headers: readHeaders(fresh) },
  );
  expect(readiness.status, await readiness.clone().text()).toBe(200);
  expect(checkedTokens).toEqual(["xoxb-after-deletion"]);
  const slack = await slackAccount(fresh);
  expect(slack).toMatchObject({
    lifecycle: { kind: "active" },
    credential_health: { kind: "healthy" },
  });

  // A failed check marks the account as needing attention. When Slack
  // answers again, the next check must make it usable without a reconnect.
  const freshScope = await requireOrganisationExecutionScope(
    env,
    fresh.organisationId,
  );
  await freshScope.database
    .prepare(
      `UPDATE integration_account
       SET lifecycle = 'degraded', lifecycle_reason_code = 'provider_manifest_unhealthy'
       WHERE organisation_id = ? AND provider = 'slack'`,
    )
    .bind(fresh.organisationId)
    .run();
  checkedTokens.length = 0;
  const recheck = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${fresh.organisationId}/readiness`,
    { headers: readHeaders(fresh) },
  );
  expect(recheck.status, await recheck.clone().text()).toBe(200);
  expect(checkedTokens).toEqual(["xoxb-after-deletion"]);
  const recovered = await slackAccount(fresh);
  expect(recovered).toMatchObject({ lifecycle: { kind: "active" } });

  // The new workspace is already active when its owner adds the channel
  // that the deleted Organisation left behind. Adding it keeps the workspace
  // active and gives the channel the grants of a channel Café posts in.
  await markActive(fresh);
  const before = await lifecycleState(fresh.organisationId);
  const released = await bindChannel(fresh, connection, RELEASED_CHANNEL);
  expect(released.status, await released.clone().text()).toBe(200);
  expect(await lifecycleState(fresh.organisationId)).toEqual(before);
  expect(await channelCapabilities(fresh, RELEASED_CHANNEL)).toEqual([
    "context.case.read",
    "message.attachment.inspect",
    "message.link.read",
  ]);

  // It cannot take the channel that an Organisation in use still holds.
  const held = await bindChannel(fresh, connection, HELD_CHANNEL);
  expect(held.status).toBe(409);
  expect(await held.json()).toMatchObject({
    error: "slack_channel_default_conflict",
  });

  const channels = (await activeConnection(fresh)).channels;
  expect(channels).toEqual([{ channelId: RELEASED_CHANNEL, revision: 2 }]);
  expect(await channelOwner(HELD_CHANNEL)).toBe(inUse.organisationId);
  expect(await channelCapabilities(fresh, HELD_CHANNEL)).toEqual([]);

  task.meta.slackChannelAfterDeletion = {
    installationId: INSTALLATION_ID,
    slackAfterTakeover: {
      lifecycle: slack.lifecycle,
      credentialHealth: slack.credential_health,
    },
    slackAfterFailedCheck: recovered.lifecycle,
    releasedChannel: { status: released.status, channels },
    heldChannel: { status: held.status, owner: inUse.organisationId },
  };
}

/** The Slack account as the Portal's Integrations page reads it. */
async function slackAccount(owner: Owner): Promise<Record<string, unknown>> {
  const response = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${owner.organisationId}`,
    { headers: readHeaders(owner) },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const body: unknown = await response.json();
  const projection =
    isRecord(body) && isRecord(body.projection) ? body.projection : body;
  const accounts =
    isRecord(projection) && Array.isArray(projection.provider_accounts)
      ? projection.provider_accounts
      : [];
  for (const account of accounts)
    if (isRecord(account) && account.provider === "slack") return account;
  throw new Error("The Organisation has no Slack account");
}

/** Input: a workspace that its owner has already activated. */
async function markActive(owner: Owner): Promise<void> {
  const scope = await requireOrganisationExecutionScope(
    env,
    owner.organisationId,
  );
  await scope.database
    .prepare(
      `UPDATE organisation_onboarding
       SET lifecycle = 'active', activated_at = ?,
           activation_receipt_id = 'receipt_e2e_slack_after_deletion'
       WHERE organisation_id = ?`,
    )
    .bind(Date.now(), owner.organisationId)
    .run();
}

async function lifecycleState(
  organisationId: OrganisationId,
): Promise<Readonly<{ lifecycle: unknown; configurationVersion: unknown }>> {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const row = await scope.database
    .prepare(
      `SELECT lifecycle, configuration_version AS configurationVersion
       FROM organisation_onboarding WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<{ lifecycle: unknown; configurationVersion: unknown }>();
  return {
    lifecycle: row?.lifecycle,
    configurationVersion: row?.configurationVersion,
  };
}

/** The capabilities that people in a Slack channel hold, as stored grants. */
async function channelCapabilities(
  owner: Owner,
  channelId: string,
): Promise<readonly string[]> {
  const scope = await requireOrganisationExecutionScope(
    env,
    owner.organisationId,
  );
  const grants = await listAccessGrants({
    db: scope.database,
    organisationId: owner.organisationId,
    lifecycle: "active",
  });
  if (!grants.ok) throw new Error(grants.error.code);
  return grants.value
    .flatMap(function capability(grant) {
      return grant.subject.kind === "conversation" &&
        grant.subject.conversationId === channelId &&
        grant.target.kind === "platform_capability"
        ? [grant.target.capabilityId]
        : [];
    })
    .sort();
}

async function nativeOwner(label: string): Promise<Owner> {
  const client = await commerceClient(`slack-after-deletion-${label}`);
  const organisationId = await commerceWorkspace(client, `${label} cafe`);
  return { client, organisationId };
}

/**
 * The workspace as two Organisations left it: one installation, a connection
 * for each, and the channel each posts in.
 */
async function seedWorkspace(installer: Owner, other: Owner): Promise<void> {
  const now = Date.now() - 10_000;
  const tokenRef = "vault:slack:bot:after-deletion";
  const stored = await storeVaultSecret({
    db: fixtureDatabase(),
    keys: env,
    organisationId: installer.organisationId,
    handle: requiredHandle(tokenRef),
    secret: { kind: "bearer", value: "xoxb-installed-by-deleted" },
    now,
  });
  if (!stored.ok) throw new Error(stored.error.code);
  await env.DB.prepare(
    `INSERT INTO slack_installation (
       installation_id, environment, app_id, workspace_id,
       credential_organisation_id, bot_token_ref, install_model, scopes_json,
       lifecycle, installed_at, updated_at, disabled_at, revoked_at
     ) VALUES (?, 'development', ?, ?, ?, ?, 'unlisted', ?, 'active', ?, ?, NULL, NULL)`,
  )
    .bind(
      INSTALLATION_ID,
      APP_ID,
      TEAM_ID,
      installer.organisationId,
      tokenRef,
      JSON.stringify(SLACK_SCOPES),
      now,
      now,
    )
    .run();
  for (const [owner, channel] of [
    [installer, RELEASED_CHANNEL],
    [other, HELD_CHANNEL],
  ] as const) {
    const connected = await createActiveConnectedIntegration(
      fixtureDatabase(),
      {
        organisationId: owner.organisationId,
        provider: "slack",
        providerSubjectId: TEAM_ID,
        environment: "development",
        authMode: "shared_pantry_app",
        authority: {
          kind: "connection_credential",
          credentialRef: requiredHandle(tokenRef),
        },
        grantedScopes: [...SLACK_SCOPES],
        createdByUserId: owner.client.identity.userId,
        providerAccountId: TEAM_ID,
        accountKind: "workspace",
        displayName: "Cafe Workspace",
        capabilities: ["conversation.ingress", "conversation.egress"],
        audiencePolicy: { kind: "operator" },
        retentionPolicy: { kind: "organisation_default" },
        now,
      },
    );
    const connectionId = `connection_e2e_${channel.toLowerCase()}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO slack_organisation_connection (
           connection_id, installation_id, organisation_id, integration_account_id,
           lifecycle, revision, connected_at, updated_at, disabled_at, revoked_at
         ) VALUES (?, ?, ?, ?, 'active', 1, ?, ?, NULL, NULL)`,
      ).bind(
        connectionId,
        INSTALLATION_ID,
        owner.organisationId,
        connected.account.integrationAccountId,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO slack_channel_default (
           installation_id, channel_id, connection_id, revision,
           bound_by_user_id, bound_at
         ) VALUES (?, ?, ?, 1, ?, ?)`,
      ).bind(
        INSTALLATION_ID,
        channel,
        connectionId,
        owner.client.identity.userId,
        now,
      ),
    ]);
  }
}

function requiredHandle(raw: string): VaultHandle {
  const handle = parseVaultHandle(raw);
  if (!handle.ok) throw new Error("The Slack token handle is invalid");
  return handle.value;
}

async function connectSlack(owner: Owner): Promise<void> {
  const started = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${owner.organisationId}/providers/slack/start`,
    {
      method: "POST",
      headers: mutationHeaders(
        owner,
        "slack-start",
        await configurationVersion(owner.organisationId),
      ),
      body: JSON.stringify({ returnPath: `/portal/${owner.organisationId}` }),
    },
  );
  expect(started.status, await started.clone().text()).toBe(201);
  const body = await started.json();
  if (!isRecord(body) || typeof body.authorization_url !== "string")
    throw new Error("Slack start returned no authorization address");
  const state = new URL(body.authorization_url).searchParams.get("state");
  if (state === null) throw new Error("Slack authorization has no state");
  const callback = new URL(
    `${PUBLIC_ORIGIN}/v1/control/providers/slack/callback`,
  );
  callback.searchParams.set("code", "slack-code-after-deletion");
  callback.searchParams.set("state", state);
  const completed = await exports.default.fetch(callback.toString());
  expect(completed.status).toBe(200);
  await expect(completed.text()).resolves.toContain(
    "pantry.provider-attempt.completed",
  );
}

async function activeConnection(owner: Owner): Promise<RoutingConnection> {
  const response = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${owner.organisationId}/slack-routing`,
    { headers: readHeaders(owner) },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const body = await response.json();
  const connections =
    isRecord(body) && Array.isArray(body.connections) ? body.connections : [];
  for (const raw of connections) {
    if (!isRecord(raw) || raw.lifecycle !== "active") continue;
    const defaults = Array.isArray(raw.channelDefaults)
      ? raw.channelDefaults
      : [];
    return {
      installationId: String(raw.installationId),
      connectionId: String(raw.connectionId),
      channels: defaults.filter(isRecord).map(function channel(row) {
        return {
          channelId: String(row.channelId),
          revision: Number(row.revision),
        };
      }),
    };
  }
  throw new Error("The Organisation has no active Slack connection");
}

function bindChannel(
  owner: Owner,
  connection: RoutingConnection,
  channelId: string,
): Promise<Response> {
  return exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${owner.organisationId}/slack-routing/installations/${connection.installationId}/channels/${channelId}`,
    {
      method: "PUT",
      headers: mutationHeaders(owner, `bind-${channelId}`, null),
      body: JSON.stringify({
        kind: "bind_unbound",
        destinationOrganisationId: owner.organisationId,
        destinationConnectionId: connection.connectionId,
      }),
    },
  );
}

async function connectionLifecycle(
  organisationId: OrganisationId,
): Promise<unknown> {
  return env.DB.prepare(
    "SELECT lifecycle FROM slack_organisation_connection WHERE organisation_id = ?",
  )
    .bind(organisationId)
    .first("lifecycle");
}

async function channelOwner(channelId: string): Promise<unknown> {
  return env.DB.prepare(
    `SELECT connection.organisation_id AS organisationId
     FROM slack_channel_default AS channel
     JOIN slack_organisation_connection AS connection
       ON connection.installation_id = channel.installation_id
      AND connection.connection_id = channel.connection_id
     WHERE channel.installation_id = ? AND channel.channel_id = ?`,
  )
    .bind(INSTALLATION_ID, channelId)
    .first("organisationId");
}

async function lifecycleMutation(
  owner: Owner,
  operation: "archive" | "delete",
): Promise<ArchiveOrganisationMutation> {
  return {
    boundary: {
      kind: "configuration_versioned",
      idempotencyKey: `slack-after-deletion-${operation}`,
      requestHash: `slack-after-deletion-${operation}-request`,
      expectedConfigurationVersion: await configurationVersion(
        owner.organisationId,
      ),
    },
    scope: {
      userId: owner.client.identity.userId,
      organisationScope: owner.organisationId,
      route: `/v1/control/organisations/${owner.organisationId}${operation === "archive" ? "/archive" : ""}`,
      operation: `organisation.${operation}`,
    },
    identity: newControlMutationIdentity({
      portalSubjectHash: "slack-after-deletion-owner",
      causationId: `slack-after-deletion-${operation}`,
      now: Date.now(),
    }),
  };
}

function mutationHeaders(
  owner: Owner,
  idempotencyKey: string,
  version: number | null,
): HeadersInit {
  return {
    ...readHeaders(owner),
    origin: PUBLIC_ORIGIN,
    "content-type": "application/json",
    "idempotency-key": `slack-after-deletion-${idempotencyKey}`,
    ...(version === null
      ? {}
      : { "x-pantry-configuration-version": String(version) }),
    "x-pantry-csrf": owner.client.session.csrfToken,
  };
}
