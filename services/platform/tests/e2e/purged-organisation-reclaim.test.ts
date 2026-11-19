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
  createCustomConnectorDraft,
  prepareCustomConnectorDraftDocument,
} from "../../src/custom-connectors/revisions";
import { createActiveConnectedIntegration } from "../../src/data/integration-account";
import type { OrganisationId } from "../../src/ids";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { network } from "./network";
import {
  configurationVersion,
  erasedTableResidue,
  purgeOrganisation,
  purgeOwner,
  readHeaders,
  type PurgeOwner,
} from "./purge-support";
import { attachSharedAccountNativeOrganisation } from "./shared-account-platform-fixture";

declare module "vitest" {
  interface TaskMeta {
    purgedOrganisationReclaim?: Record<string, unknown>;
  }
}

const PUBLIC_ORIGIN = "https://localhost";
const NAME = "Reclaim bakery";
const APP_ID = "A12345678";
const TEAM_ID = "T0RECLAIM1";
const INSTALLATION_ID = "installation_e2e_reclaim";
const PURGED_TOKEN = "xoxb-installed-by-purged";
const RECLAIM_TOKEN = "xoxb-after-reclaim";
const DM_USER = "U0DMPERSON";
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

it(
  "erases each catalogue table of a purged Organisation and lets a new Organisation take its handle and its Slack workspace, while the Organisation that shares the workspace keeps its Slack",
  purgedOrganisationReclaimJourney,
  180_000,
);

async function purgedOrganisationReclaimJourney({ task }: TestContext) {
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
        access_token: RECLAIM_TOKEN,
        scope: SLACK_SCOPES.join(","),
        bot_user_id: "U0SATYRBOT",
        team: { id: TEAM_ID, name: "Reclaim Workspace" },
      }),
    ),
    http.get("https://slack.com/api/conversations.list", () =>
      HttpResponse.json({
        ok: true,
        channels: [],
        response_metadata: { next_cursor: "" },
      }),
    ),
  );

  // The first Organisation installed the workspace, signed in to ChatGPT,
  // drafted a custom connector, and a person picked it for their Slack DMs.
  // A second Organisation uses the same workspace.
  const purged = await purgeOwner("reclaim-purged", NAME);
  const neighbour = await purgeOwner("reclaim-neighbour", "Neighbour cafe");
  const purgedHandle = await directoryHandle(purged.organisationId);
  expect(purgedHandle).not.toBeNull();
  await seedWorkspace(purged, neighbour);
  await connectChatGpt(purged);
  await draftCustomConnector(purged);
  const before = await erasedTableResidue(purged.organisationId);
  expect(before).toMatchObject({
    organisation_codex_connection: 1,
    custom_connector: 1,
    custom_connector_revision: 1,
  });

  await purgeOrganisation(purged);

  // Nothing that the purge erases names the purged Organisation, its Vault
  // included, and no Slack record of the directory names it. The Organisation
  // keeps no handle.
  expect(await erasedTableResidue(purged.organisationId)).toEqual({});
  expect(await slackRecordsNaming(purged.organisationId)).toEqual({
    installationsOwned: 0,
    dmSelections: 0,
    threadPins: 0,
  });
  const purgedRow = await purgedOrganisationRow(purged.organisationId);
  expect(purgedRow).toEqual({
    status: "purged",
    handle: null,
    lifecycle: "purged",
  });
  expect(await directoryHandle(purged.organisationId)).toBeNull();

  // A new Organisation with the same name gets the same handle. The account
  // authority serves it and the Organisation that shares the workspace.
  const fresh = await purgeOwner("reclaim-fresh", NAME);
  expect(await directoryHandle(fresh.organisationId)).toBe(purgedHandle);
  await attachSharedAccountNativeOrganisation({
    organisationId: fresh.organisationId,
    owner: fresh.client,
    members: {},
    foreign: {
      organisationId: neighbour.organisationId,
      owner: neighbour.client,
    },
  });

  // The Organisation that shares the workspace keeps its Slack: its token is
  // the one that the purged Organisation's Vault held.
  checkedTokens.length = 0;
  const neighbourReadiness = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${neighbour.organisationId}/readiness`,
    { headers: readHeaders(neighbour) },
  );
  expect(
    neighbourReadiness.status,
    await neighbourReadiness.clone().text(),
  ).toBe(200);
  expect(checkedTokens).toEqual([PURGED_TOKEN]);
  expect(await slackAccount(neighbour)).toMatchObject({
    lifecycle: { kind: "active" },
    credential_health: { kind: "healthy" },
  });

  // The new Organisation connects the same workspace.
  await connectSlack(fresh);
  checkedTokens.length = 0;
  const freshReadiness = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${fresh.organisationId}/readiness`,
    { headers: readHeaders(fresh) },
  );
  expect(freshReadiness.status, await freshReadiness.clone().text()).toBe(200);
  expect(checkedTokens).toEqual([RECLAIM_TOKEN]);
  expect(await slackAccount(fresh)).toMatchObject({
    lifecycle: { kind: "active" },
    credential_health: { kind: "healthy" },
  });
  // The reclaim leaves nothing in the purged Organisation's tables either.
  expect(await erasedTableResidue(purged.organisationId)).toEqual({});
  const owner = await installationOwner();

  task.meta.purgedOrganisationReclaim = {
    purgedOrganisation: purged.organisationId,
    handleReused: purgedHandle,
    erasedTablesWithRowsBefore: Object.keys(before).length,
    purgedRow,
    neighbourSlackAfterPurge: "healthy with the moved token",
    freshSlack: "healthy with its own token",
    installationOwner:
      owner === neighbour.organisationId ? "neighbour" : String(owner),
  };
}

async function directoryHandle(
  organisationId: OrganisationId,
): Promise<unknown> {
  return env.DB.prepare(
    "SELECT organisation_handle FROM organisation WHERE organisation_id = ?",
  )
    .bind(organisationId)
    .first("organisation_handle");
}

function requiredHandle(raw: string): VaultHandle {
  const handle = parseVaultHandle(raw);
  if (!handle.ok) throw new Error("The token handle is invalid");
  return handle.value;
}

/**
 * The workspace as two Organisations left it: one installation whose token
 * the first holds, a connection for each, a person's DM choice of the first
 * and a thread pinned to it.
 */
async function seedWorkspace(
  installer: PurgeOwner,
  other: PurgeOwner,
): Promise<void> {
  const now = Date.now() - 10_000;
  const tokenRef = `vault:${installer.organisationId.toLowerCase()}:slack:reclaim`;
  const installerScope = await requireOrganisationExecutionScope(
    env,
    installer.organisationId,
  );
  const stored = await storeVaultSecret({
    db: installerScope.database,
    keys: env,
    organisationId: installer.organisationId,
    handle: requiredHandle(tokenRef),
    secret: { kind: "bearer", value: PURGED_TOKEN },
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
  for (const [owner, label] of [
    [installer, "installer"],
    [other, "other"],
  ] as const) {
    const scope = await requireOrganisationExecutionScope(
      env,
      owner.organisationId,
    );
    const connected = await createActiveConnectedIntegration(scope.database, {
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
      displayName: "Reclaim Workspace",
      capabilities: ["conversation.ingress", "conversation.egress"],
      audiencePolicy: { kind: "operator" },
      retentionPolicy: { kind: "organisation_default" },
      now,
    });
    await env.DB.prepare(
      `INSERT INTO slack_organisation_connection (
         connection_id, installation_id, organisation_id, integration_account_id,
         lifecycle, revision, connected_at, updated_at, disabled_at, revoked_at
       ) VALUES (?, ?, ?, ?, 'active', 1, ?, ?, NULL, NULL)`,
    )
      .bind(
        `connection_e2e_reclaim_${label}`,
        INSTALLATION_ID,
        owner.organisationId,
        connected.account.integrationAccountId,
        now,
        now,
      )
      .run();
  }
  const installerAccount = await env.DB.prepare(
    `SELECT integration_account_id AS id FROM slack_organisation_connection
     WHERE connection_id = 'connection_e2e_reclaim_installer'`,
  ).first<string>("id");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO slack_dm_organisation_selection (
         installation_id, external_user_id, connection_id, revision, selected_at
       ) VALUES (?, ?, 'connection_e2e_reclaim_installer', 1, ?)`,
    ).bind(INSTALLATION_ID, DM_USER, now),
    env.DB.prepare(
      `INSERT INTO slack_thread_case_pin (
         installation_id, channel_id, root_message_ts, connection_id,
         organisation_id, integration_account_id, case_id,
         routing_source_kind, routing_source_revision, pinned_at
       ) VALUES (?, 'D0DMPERSON', '1700000000.000100', 'connection_e2e_reclaim_installer',
         ?, ?, 'case_e2e_reclaim', 'dm_selection', 1, ?)`,
    ).bind(INSTALLATION_ID, installer.organisationId, installerAccount, now),
  ]);
}

/** Input: the ChatGPT sign-in that the Organisation's owner finished. */
async function connectChatGpt(owner: PurgeOwner): Promise<void> {
  const now = Date.now();
  const scope = await requireOrganisationExecutionScope(
    env,
    owner.organisationId,
  );
  const handle = requiredHandle(
    `vault:${owner.organisationId.toLowerCase()}:codex:profile:1`,
  );
  const stored = await storeVaultSecret({
    db: scope.database,
    keys: env,
    organisationId: owner.organisationId,
    handle,
    secret: { kind: "bearer", value: "chatgpt-profile-before-purge" },
    now,
  });
  if (!stored.ok) throw new Error(stored.error.code);
  await scope.database
    .prepare(
      `INSERT INTO organisation_codex_connection (
         organisation_id, lifecycle, revision, auth_profile_handle,
         auth_profile_generation, plan_type, action_required_reason,
         allowance_json, connected_at, verified_at, observed_at, updated_at,
         refresh_lease, refresh_until
       ) VALUES (?, 'connected', 1, ?, 1, 'plus', NULL, '{}', ?, ?, ?, ?, NULL, NULL)`,
    )
    .bind(owner.organisationId, handle, now, now, now, now)
    .run();
}

async function draftCustomConnector(owner: PurgeOwner): Promise<void> {
  const scope = await requireOrganisationExecutionScope(
    env,
    owner.organisationId,
  );
  const document = await prepareCustomConnectorDraftDocument({
    schemaVersion: 1,
    name: "Supplier API",
  });
  if (!document.ok) throw new Error(document.error.code);
  await createCustomConnectorDraft({
    db: scope.database,
    organisationId: owner.organisationId,
    createdByUserId: owner.client.identity.userId,
    document: document.value,
    now: Date.now(),
  });
}

/** The Organisation's own row and its onboarding lifecycle, in its region. */
async function purgedOrganisationRow(
  organisationId: OrganisationId,
): Promise<unknown> {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  return scope.database
    .prepare(
      `SELECT organisation.status AS status, organisation.organisation_handle AS handle,
              onboarding.lifecycle AS lifecycle
       FROM organisation
       JOIN organisation_onboarding AS onboarding
         ON onboarding.organisation_id = organisation.organisation_id
       WHERE organisation.organisation_id = ?`,
    )
    .bind(organisationId)
    .first();
}

/** The directory's Slack records that still name the Organisation. */
async function slackRecordsNaming(
  organisationId: OrganisationId,
): Promise<Readonly<Record<string, unknown>>> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM slack_installation
        WHERE credential_organisation_id = ?1) AS installationsOwned,
       (SELECT COUNT(*) FROM slack_dm_organisation_selection AS selection
        JOIN slack_organisation_connection AS connection
          ON connection.installation_id = selection.installation_id
         AND connection.connection_id = selection.connection_id
        WHERE connection.organisation_id = ?1) AS dmSelections,
       (SELECT COUNT(*) FROM slack_thread_case_pin WHERE organisation_id = ?1) AS threadPins`,
  )
    .bind(organisationId)
    .first();
  return row ?? {};
}

function installationOwner(): Promise<unknown> {
  return env.DB.prepare(
    "SELECT credential_organisation_id FROM slack_installation WHERE installation_id = ?",
  )
    .bind(INSTALLATION_ID)
    .first("credential_organisation_id");
}

/** The Slack account as the Portal's Integrations page reads it. */
async function slackAccount(
  owner: PurgeOwner,
): Promise<Record<string, unknown>> {
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

async function connectSlack(owner: PurgeOwner): Promise<void> {
  const started = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${owner.organisationId}/providers/slack/start`,
    {
      method: "POST",
      headers: {
        ...readHeaders(owner),
        origin: PUBLIC_ORIGIN,
        "content-type": "application/json",
        "idempotency-key": `reclaim-${owner.organisationId}-slack-start`,
        "x-satyr-configuration-version": String(
          await configurationVersion(owner.organisationId),
        ),
        "x-satyr-csrf": owner.client.session.csrfToken,
      },
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
  callback.searchParams.set("code", "slack-code-reclaim");
  callback.searchParams.set("state", state);
  const completed = await exports.default.fetch(callback.toString());
  expect(completed.status).toBe(200);
  await expect(completed.text()).resolves.toContain(
    "satyr.provider-attempt.completed",
  );
}
