import { env, exports } from "cloudflare:workers";
import { HttpResponse, http } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@seams/std";

import {
  parseVaultHandle,
  storeVaultSecret,
  type VaultHandle,
} from "../../src/credential-vault";
import {
  createActiveConnectedIntegration,
  upsertSurfaceInstallation,
} from "../../src/data/integration-account";
import type { OrganisationId } from "../../src/ids";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { commerceClient, commerceWorkspace } from "./commerce-support";
import { network } from "./network";
import { organisationDatabase } from "./organisation-database";
import {
  attachSharedAccountNativeOrganisation,
  type SharedAccountNativeClient,
} from "./shared-account-platform-fixture";

declare module "vitest" {
  interface TaskMeta {
    slackWorkspaceDmAndDisconnect?: Record<string, unknown>;
  }
}

const PUBLIC_ORIGIN = "https://localhost";
const APP_ID = "A12345678";
const TEAM_ID = "T0DMSELECT1";
const INSTALLATION_ID = "installation_e2e_dm_and_disconnect";
const SLACK_USER_ID = "U0DMOWNER1";
const BOT_TOKEN = "xoxb-dm-and-disconnect";
const SLACK_SCOPES = ["app_mentions:read", "chat:write", "im:history"] as const;

type Owner = Readonly<{
  client: SharedAccountNativeClient;
  organisationId: OrganisationId;
}>;

it(
  "lets an owner find the Slack workspace in the Access options, take its direct messages and disconnect it once, and refuses a person of another Organisation",
  slackWorkspaceDmAndDisconnectJourney,
  120_000,
);

async function slackWorkspaceDmAndDisconnectJourney({ task }: TestContext) {
  const uninstalls: string[] = [];
  network.use(
    http.post("https://slack.com/api/apps.uninstall", async ({ request }) => {
      const form = new URLSearchParams(await request.text());
      uninstalls.push(form.get("token") ?? "");
      return HttpResponse.json({ ok: true });
    }),
  );
  const owner = await nativeOwner("owner", true);
  const outsider = await nativeOwner("outsider", false);
  const connectionId = await seedWorkspace(owner);
  expect(await routingConnections(owner)).toEqual([
    { connectionId, lifecycle: "active" },
  ]);

  // The Access page offers the owner role and the Slack account by search.
  const roles = await options(owner, "subjects", "owner");
  expect(roles.status, JSON.stringify(roles.body)).toBe(200);
  expect(labels(roles.body)).toContain("Owner role");
  expect(labels(roles.body)).not.toContain("Viewer role");
  const accounts = await options(owner, "resources", "cafe");
  expect(accounts.status).toBe(200);
  expect(labels(accounts.body)).toEqual(["Cafe Slack Workspace"]);
  const none = await options(owner, "resources", "bakery");
  expect(labels(none.body)).toEqual([]);

  // The owner takes the workspace's direct messages. A retry with the same
  // key answers with the same receipt and does not select again.
  const selected = await post(owner, "dm-selection", "dm-select");
  expect(selected.status, JSON.stringify(selected.body)).toBe(200);
  expect(selected.body).toMatchObject({
    kind: "success",
    installationId: INSTALLATION_ID,
  });
  const selectedAgain = await post(owner, "dm-selection", "dm-select");
  expect(selectedAgain).toEqual(selected);

  // A person of another Organisation can neither select nor disconnect it:
  // the Organisation is not found for them.
  const foreignSelect = await post(
    outsider,
    "dm-selection",
    "foreign-dm",
    owner,
  );
  expect(foreignSelect.status, JSON.stringify(foreignSelect.body)).toBe(404);
  const foreignDisconnect = await post(
    outsider,
    "disconnect",
    "foreign-disconnect",
    owner,
  );
  expect(foreignDisconnect.status, JSON.stringify(foreignDisconnect.body)).toBe(
    404,
  );
  expect(uninstalls).toEqual([]);

  // The owner disconnects the workspace: Slack removes the app once, and a
  // retry answers with the finished receipt instead of a second removal.
  const disconnected = await post(owner, "disconnect", "disconnect");
  expect(disconnected.status, JSON.stringify(disconnected.body)).toBe(200);
  expect(disconnected.body).toMatchObject({
    kind: "success",
    installationId: INSTALLATION_ID,
    disconnectedConnectionCount: 1,
  });
  const retried = await post(owner, "disconnect", "disconnect");
  expect(retried).toEqual(disconnected);
  expect(uninstalls).toEqual([BOT_TOKEN]);
  expect(await routingConnections(owner)).toEqual([]);

  // With the workspace gone, its direct messages cannot be taken again.
  const afterDisconnect = await post(owner, "dm-selection", "dm-after");
  expect(afterDisconnect.status).toBe(404);

  task.meta.slackWorkspaceDmAndDisconnect = {
    accessOptions: {
      roles: labels(roles.body),
      accounts: labels(accounts.body),
    },
    dmSelection: selected.body,
    refusals: {
      select: foreignSelect.status,
      disconnect: foreignDisconnect.status,
    },
    disconnect: disconnected.body,
    uninstallCalls: uninstalls.length,
    afterDisconnect: afterDisconnect.status,
  };
}

async function nativeOwner(label: string, attached: boolean): Promise<Owner> {
  const client = await commerceClient(`slack-dm-disconnect-${label}`);
  const organisationId = await commerceWorkspace(client, `${label} cafe`);
  if (attached)
    await attachSharedAccountNativeOrganisation({
      organisationId,
      owner: client,
      members: {},
    });
  return { client, organisationId };
}

/**
 * Input: a workspace installation that the owner's Organisation uses, and
 * the owner's verified Slack identity in it.
 */
async function seedWorkspace(owner: Owner): Promise<string> {
  const now = Date.now() - 10_000;
  const tokenRef = "vault:slack:bot:dm-and-disconnect";
  const database = organisationDatabase(owner.organisationId);
  const stored = await storeVaultSecret({
    db: database,
    keys: env,
    organisationId: owner.organisationId,
    handle: requiredHandle(tokenRef),
    secret: { kind: "bearer", value: BOT_TOKEN },
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
      owner.organisationId,
      tokenRef,
      JSON.stringify(SLACK_SCOPES),
      now,
      now,
    )
    .run();
  const connected = await createActiveConnectedIntegration(database, {
    organisationId: owner.organisationId,
    provider: "slack",
    providerSubjectId: TEAM_ID,
    environment: "development",
    authMode: "shared_satyr_app",
    authority: {
      kind: "connection_credential",
      credentialRef: requiredHandle(tokenRef),
    },
    grantedScopes: [...SLACK_SCOPES],
    createdByUserId: owner.client.identity.userId,
    providerAccountId: TEAM_ID,
    accountKind: "workspace",
    displayName: "Cafe Slack Workspace",
    capabilities: ["conversation.ingress", "conversation.egress"],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now,
  });
  const connectionId = "connection_e2e_dm_and_disconnect";
  await env.DB.prepare(
    `INSERT INTO slack_organisation_connection (
       connection_id, installation_id, organisation_id, integration_account_id,
       lifecycle, revision, connected_at, updated_at, disabled_at, revoked_at
     ) VALUES (?, ?, ?, ?, 'active', 1, ?, ?, NULL, NULL)`,
  )
    .bind(
      connectionId,
      INSTALLATION_ID,
      owner.organisationId,
      connected.account.integrationAccountId,
      now,
      now,
    )
    .run();
  const scope = await requireOrganisationExecutionScope(
    env,
    owner.organisationId,
  );
  await upsertSurfaceInstallation({
    db: scope.database,
    account: connected.account,
    surfaceKind: "slack",
    workspaceId: TEAM_ID,
    installModel: "unlisted",
    botTokenRef: requiredHandle(tokenRef),
    scopes: [...SLACK_SCOPES],
    installedAt: now,
  });
  await scope.database
    .prepare(
      `INSERT INTO external_identity_link (
         organisation_id, workspace_connection_id, workspace_id, external_user_id,
         user_id, verified_at, verified_by
       ) VALUES (?, ?, ?, ?, ?, ?, 'google')`,
    )
    .bind(
      owner.organisationId,
      connected.connection.providerConnectionId,
      TEAM_ID,
      SLACK_USER_ID,
      owner.client.identity.userId,
      now,
    )
    .run();
  return connectionId;
}

function requiredHandle(raw: string): VaultHandle {
  const handle = parseVaultHandle(raw);
  if (!handle.ok) throw new Error("The Slack token handle is invalid");
  return handle.value;
}

async function options(
  owner: Owner,
  kind: "subjects" | "resources",
  query: string,
): Promise<Readonly<{ status: number; body: unknown }>> {
  const url = new URL(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${owner.organisationId}/access-control/options`,
  );
  url.searchParams.set("kind", kind);
  url.searchParams.set("query", query);
  const response = await exports.default.fetch(url.toString(), {
    headers: readHeaders(owner),
  });
  return { status: response.status, body: await response.json() };
}

function labels(body: unknown): readonly string[] {
  const page = isRecord(body) && isRecord(body.options) ? body.options : body;
  const items = isRecord(page) && Array.isArray(page.items) ? page.items : [];
  return items.flatMap(function label(item) {
    return isRecord(item) && typeof item.label === "string" ? [item.label] : [];
  });
}

/** A Slack routing mutation by `actor` on `target`'s workspace. */
async function post(
  actor: Owner,
  operation: "dm-selection" | "disconnect",
  idempotencyKey: string,
  target: Owner = actor,
): Promise<Readonly<{ status: number; body: unknown }>> {
  const response = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${target.organisationId}/slack-routing/installations/${INSTALLATION_ID}/${operation}`,
    {
      method: "POST",
      headers: {
        ...readHeaders(actor),
        origin: PUBLIC_ORIGIN,
        "content-type": "application/json",
        "idempotency-key": `slack-dm-disconnect-${idempotencyKey}`,
        "x-satyr-csrf": actor.client.session.csrfToken,
      },
      body: "{}",
    },
  );
  return { status: response.status, body: await response.json() };
}

async function routingConnections(
  owner: Owner,
): Promise<readonly Readonly<{ connectionId: string; lifecycle: string }>[]> {
  const response = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${owner.organisationId}/slack-routing`,
    { headers: readHeaders(owner) },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const body = await response.json();
  const connections =
    isRecord(body) && Array.isArray(body.connections) ? body.connections : [];
  return connections.filter(isRecord).map(function connection(raw) {
    return {
      connectionId: String(raw.connectionId),
      lifecycle: String(raw.lifecycle),
    };
  });
}

function readHeaders(owner: Owner): Record<string, string> {
  const { token, csrfToken } = owner.client.session;
  return {
    cookie: `satyr_control_session=${token}; satyr_control_csrf=${csrfToken}`,
  };
}
