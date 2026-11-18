import { env, exports } from "cloudflare:workers";
import { HttpResponse, http } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@seams/std";

import {
  parseVaultHandle,
  storeVaultSecret,
  type VaultHandle,
} from "../../src/credential-vault";
import { registerEmailMailboxAccount } from "../../src/data/email-mailbox";
import { registerEmailSenderAccount } from "../../src/data/email-operational";
import { createActiveConnectedIntegration } from "../../src/data/integration-account";
import type { OrganisationId } from "../../src/ids";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { network } from "./network";
import { googleIdToken } from "./gmail-mailbox-support";
import {
  configurationVersion,
  erasedTableResidue,
  purgeOrganisation,
  purgeOwner,
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
const MAILBOX_ADDRESS = "orders@reclaim.example";
const GOOGLE_SUBJECT = "google-subject-reclaim";
const GMAIL_SCOPES =
  "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/userinfo.email openid";
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
  "lets a new Organisation take the handle, the Google account and the Slack workspace of a purged one, while the Organisation that shares the workspace keeps its Slack",
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
    http.post("https://oauth2.googleapis.com/token", () =>
      HttpResponse.json({
        access_token: "gmail-access-reclaim",
        refresh_token: "gmail-refresh-reclaim",
        expires_in: 3_600,
        scope: GMAIL_SCOPES,
        id_token: googleIdToken(GOOGLE_SUBJECT, MAILBOX_ADDRESS),
      }),
    ),
    http.post("https://oauth2.googleapis.com/revoke", () =>
      HttpResponse.json({}),
    ),
  );

  // The first Organisation installed the workspace, holds the Google
  // account, and a person picked it for their Slack DMs. A second
  // Organisation uses the same workspace.
  const purged = await purgeOwner("reclaim-purged", NAME);
  const neighbour = await purgeOwner("reclaim-neighbour", "Neighbour cafe");
  const purgedHandle = await directoryHandle(purged.organisationId);
  await seedWorkspace(purged, neighbour);
  await holdGoogleAccount(purged);

  await purgeOrganisation(purged);

  // Nothing that the purge erases names the purged Organisation, its Vault
  // included, and no Slack record of the directory names it.
  expect(await erasedTableResidue(purged.organisationId)).toEqual({});
  expect(await slackRecordsNaming(purged.organisationId)).toEqual({
    installationsOwned: 0,
    dmSelections: 0,
    threadPins: 0,
  });

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

  // The new Organisation connects the same Google account and the same
  // workspace.
  expect(await connectGmail(fresh)).toEqual({
    terminalState: "connected",
    failureReason: null,
  });
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
    neighbourSlackAfterPurge: "healthy with the moved token",
    freshGmail: "connected",
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

/** The records that a finished Gmail connection leaves. */
async function holdGoogleAccount(owner: PurgeOwner): Promise<void> {
  const now = Date.now() - 10_000;
  const scope = await requireOrganisationExecutionScope(
    env,
    owner.organisationId,
  );
  const handle = requiredHandle(
    `vault:${owner.organisationId.toLowerCase()}:gmail:reclaim`,
  );
  const stored = await storeVaultSecret({
    db: scope.database,
    keys: env,
    organisationId: owner.organisationId,
    handle,
    secret: {
      kind: "oauth_tokens",
      accessToken: "gmail-access-held",
      refreshToken: "gmail-refresh-held",
      expiry: { kind: "expires", expiresAt: now + 3_600_000 },
    },
    now,
  });
  if (!stored.ok) throw new Error(stored.error.code);
  const connected = await createActiveConnectedIntegration(scope.database, {
    organisationId: owner.organisationId,
    provider: "gmail",
    providerSubjectId: GOOGLE_SUBJECT,
    environment: "development",
    authMode: "shared_satyr_app",
    authority: { kind: "connection_credential", credentialRef: handle },
    grantedScopes: GMAIL_SCOPES.split(" "),
    createdByUserId: owner.client.identity.userId,
    providerAccountId: GOOGLE_SUBJECT,
    accountKind: "mailbox",
    displayName: MAILBOX_ADDRESS,
    capabilities: ["mailbox.ingress", "email.operational.propose"],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now,
  });
  const claim = {
    db: scope.database,
    organisationId: owner.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    environment: "development",
    googleSubject: GOOGLE_SUBJECT,
    observedAddress: MAILBOX_ADDRESS,
    now,
  } as const;
  const sender = await registerEmailSenderAccount(claim);
  if (!sender.ok) throw new Error(sender.error.code);
  const mailbox = await registerEmailMailboxAccount(claim);
  if (!mailbox.ok) throw new Error(mailbox.error.code);
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
  const state = await startProvider(owner, "slack");
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

async function connectGmail(
  owner: PurgeOwner,
): Promise<Readonly<{ terminalState: string; failureReason: string | null }>> {
  const state = await startProvider(owner, "gmail");
  const callback = new URL(
    `${PUBLIC_ORIGIN}/v1/control/providers/gmail/callback`,
  );
  callback.searchParams.set("code", "gmail-code-reclaim");
  callback.searchParams.set("state", state);
  const completed = await exports.default.fetch(callback.toString());
  const report =
    /"terminal_state":"(\w+)","failure_reason_code":(?:"(\w+)"|null)/u.exec(
      await completed.text(),
    );
  if (report === null) throw new Error("The window reports no result");
  return { terminalState: report[1] ?? "", failureReason: report[2] ?? null };
}

async function startProvider(
  owner: PurgeOwner,
  provider: "slack" | "gmail",
): Promise<string> {
  const started = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${owner.organisationId}/providers/${provider}/start`,
    {
      method: "POST",
      headers: {
        ...readHeaders(owner),
        origin: PUBLIC_ORIGIN,
        "content-type": "application/json",
        "idempotency-key": `reclaim-${owner.organisationId}-${provider}-start`,
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
    throw new Error(`${provider} start returned no authorization address`);
  const state = new URL(body.authorization_url).searchParams.get("state");
  if (state === null) throw new Error(`${provider} authorization has no state`);
  return state;
}

function readHeaders(owner: PurgeOwner): Record<string, string> {
  const { token, csrfToken } = owner.client.session;
  return {
    cookie: `satyr_control_session=${token}; satyr_control_csrf=${csrfToken}`,
  };
}
