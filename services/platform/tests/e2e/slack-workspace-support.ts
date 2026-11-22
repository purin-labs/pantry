import { env, exports } from "cloudflare:workers";
import { HttpResponse, http } from "msw";
import { expect } from "vitest";
import { isRecord } from "@purin-labs/std";

import { storeVaultSecret } from "../../src/credential-vault";
import { createActiveConnectedIntegration } from "../../src/data/integration-account";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import {
  readHeaders,
  requiredVaultHandle,
  type PurgeOwner,
} from "./purge-support";

export const PUBLIC_ORIGIN = "https://localhost";

export const SLACK_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "channels:history",
  "channels:read",
  "files:read",
  "groups:history",
  "groups:read",
  "im:history",
] as const;

/** One Slack workspace that two Organisations of a journey share. */
export type SharedSlackWorkspace = Readonly<{
  /** Names the journey's records: connections, the token handle, the Case. */
  key: string;
  appId: string;
  teamId: string;
  installationId: string;
  /** The bot token that the installing Organisation's Vault holds. */
  botToken: string;
  dmUser: string;
}>;

/**
 * Slack's `auth.test`, which records each bot token that a check sends. A
 * readiness read checks the token of each Slack account.
 */
export function slackAuthTestHandler(teamId: string, checkedTokens: string[]) {
  return http.post("https://slack.com/api/auth.test", ({ request }) => {
    checkedTokens.push(
      (request.headers.get("authorization") ?? "").replace(/^Bearer /u, ""),
    );
    return HttpResponse.json({ ok: true, team_id: teamId });
  });
}

/**
 * The workspace as two Organisations left it: one installation whose token
 * the first holds, a connection for each, a person's DM choice of the first
 * and a thread pinned to it.
 */
export async function seedSharedSlackWorkspace(
  workspace: SharedSlackWorkspace,
  installer: PurgeOwner,
  other: PurgeOwner,
): Promise<void> {
  const now = Date.now() - 10_000;
  const installerConnection = await seedSlackWorkspace(
    workspace,
    installer,
    [other],
    now,
  );
  const installerAccount = await env.DB.prepare(
    "SELECT integration_account_id AS id FROM slack_organisation_connection WHERE connection_id = ?",
  )
    .bind(installerConnection)
    .first<string>("id");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO slack_dm_organisation_selection (
         installation_id, external_user_id, connection_id, revision, selected_at
       ) VALUES (?, ?, ?, 1, ?)`,
    ).bind(
      workspace.installationId,
      workspace.dmUser,
      installerConnection,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO slack_thread_case_pin (
         installation_id, channel_id, root_message_ts, connection_id,
         organisation_id, integration_account_id, case_id,
         routing_source_kind, routing_source_revision, pinned_at
       ) VALUES (?, 'D0DMPERSON', '1700000000.000100', ?, ?, ?, ?, 'dm_selection', 1, ?)`,
    ).bind(
      workspace.installationId,
      installerConnection,
      installer.organisationId,
      installerAccount,
      `case_e2e_${workspace.key}`,
      now,
    ),
  ]);
}

/**
 * A Slack workspace that `installer` installed: its Vault holds the bot
 * token, and it and each of `others` has an active connection. Answers the
 * installer's connection.
 */
export async function seedSlackWorkspace(
  workspace: SharedSlackWorkspace,
  installer: PurgeOwner,
  others: readonly PurgeOwner[] = [],
  now: number = Date.now() - 10_000,
): Promise<string> {
  const tokenRef = requiredVaultHandle(
    `vault:${installer.organisationId.toLowerCase()}:slack:${workspace.key}`,
  );
  const installerScope = await requireOrganisationExecutionScope(
    env,
    installer.organisationId,
  );
  const stored = await storeVaultSecret({
    db: installerScope.database,
    keys: env,
    organisationId: installer.organisationId,
    handle: tokenRef,
    secret: { kind: "bearer", value: workspace.botToken },
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
      workspace.installationId,
      workspace.appId,
      workspace.teamId,
      installer.organisationId,
      tokenRef,
      JSON.stringify(SLACK_SCOPES),
      now,
      now,
    )
    .run();
  const installerConnection = `connection_e2e_${workspace.key}_installer`;
  for (const [owner, connectionId] of [
    [installer, installerConnection],
    ...others.map(
      (other, index) =>
        [other, `connection_e2e_${workspace.key}_other_${index}`] as const,
    ),
  ] as const) {
    const scope = await requireOrganisationExecutionScope(
      env,
      owner.organisationId,
    );
    const connected = await createActiveConnectedIntegration(scope.database, {
      organisationId: owner.organisationId,
      provider: "slack",
      providerSubjectId: workspace.teamId,
      environment: "development",
      authMode: "shared_pantry_app",
      authority: { kind: "connection_credential", credentialRef: tokenRef },
      grantedScopes: [...SLACK_SCOPES],
      createdByUserId: owner.client.identity.userId,
      providerAccountId: workspace.teamId,
      accountKind: "workspace",
      displayName: "Shared Workspace",
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
        connectionId,
        workspace.installationId,
        owner.organisationId,
        connected.account.integrationAccountId,
        now,
        now,
      )
      .run();
  }
  return installerConnection;
}

/** The directory's Slack records that still name the Organisation. */
export async function slackRecordsNaming(
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

/** The installation's credential owner and its token handle. */
export async function slackInstallationCredential(
  installationId: string,
): Promise<Readonly<Record<string, unknown>> | null> {
  return env.DB.prepare(
    `SELECT credential_organisation_id AS owner, bot_token_ref AS tokenRef,
            lifecycle, updated_at AS updatedAt
     FROM slack_installation WHERE installation_id = ?`,
  )
    .bind(installationId)
    .first();
}

/**
 * The bot tokens that one readiness read of the Organisation sends to
 * Slack's `auth.test`.
 */
export async function slackTokensCheckedByReadiness(
  owner: PurgeOwner,
  checkedTokens: string[],
): Promise<readonly string[]> {
  checkedTokens.length = 0;
  const readiness = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${owner.organisationId}/readiness`,
    { headers: readHeaders(owner) },
  );
  expect(readiness.status, await readiness.clone().text()).toBe(200);
  return [...checkedTokens];
}

/** The Slack account as the Portal's Integrations page reads it. */
export async function slackAccount(
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
