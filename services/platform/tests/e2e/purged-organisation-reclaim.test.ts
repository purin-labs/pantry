import { env, exports } from "cloudflare:workers";
import { HttpResponse, http } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import {
  createCustomConnectorDraft,
  prepareCustomConnectorDraftDocument,
} from "../../src/custom-connectors/revisions";
import type { OrganisationId } from "../../src/ids";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { network } from "./network";
import {
  PUBLIC_ORIGIN,
  SLACK_SCOPES,
  seedSharedSlackWorkspace,
  slackAccount,
  slackAuthTestHandler,
  slackInstallationCredential,
  slackRecordsNaming,
  slackTokensCheckedByReadiness,
  type SharedSlackWorkspace,
} from "./slack-workspace-support";
import {
  configurationVersion,
  erasedTableResidue,
  purgeOrganisation,
  purgeOwner,
  readHeaders,
  signInToChatGpt,
  type PurgeOwner,
} from "./purge-support";
import { attachSharedAccountNativeOrganisation } from "./shared-account-platform-fixture";

declare module "vitest" {
  interface TaskMeta {
    purgedOrganisationReclaim?: Record<string, unknown>;
  }
}

const NAME = "Reclaim bakery";
const APP_ID = "A12345678";
const TEAM_ID = "T0RECLAIM1";
const INSTALLATION_ID = "installation_e2e_reclaim";
const PURGED_TOKEN = "xoxb-installed-by-purged";
const RECLAIM_TOKEN = "xoxb-after-reclaim";
const WORKSPACE: SharedSlackWorkspace = {
  key: "reclaim",
  appId: APP_ID,
  teamId: TEAM_ID,
  installationId: INSTALLATION_ID,
  botToken: PURGED_TOKEN,
  dmUser: "U0DMPERSON",
};

it(
  "erases each catalogue table of a purged Organisation and lets a new Organisation take its handle and its Slack workspace, while the Organisation that shares the workspace keeps its Slack",
  purgedOrganisationReclaimJourney,
  180_000,
);

async function purgedOrganisationReclaimJourney({ task }: TestContext) {
  const checkedTokens: string[] = [];
  network.use(
    slackAuthTestHandler(TEAM_ID, checkedTokens),
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
  await seedSharedSlackWorkspace(WORKSPACE, purged, neighbour);
  await signInToChatGpt(purged);
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
  expect(await slackTokensCheckedByReadiness(neighbour, checkedTokens)).toEqual(
    [PURGED_TOKEN],
  );
  expect(await slackAccount(neighbour)).toMatchObject({
    lifecycle: { kind: "active" },
    credential_health: { kind: "healthy" },
  });

  // The new Organisation connects the same workspace.
  await connectSlack(fresh);
  expect(await slackTokensCheckedByReadiness(fresh, checkedTokens)).toEqual([
    RECLAIM_TOKEN,
  ]);
  expect(await slackAccount(fresh)).toMatchObject({
    lifecycle: { kind: "active" },
    credential_health: { kind: "healthy" },
  });
  // The reclaim leaves nothing in the purged Organisation's tables either.
  expect(await erasedTableResidue(purged.organisationId)).toEqual({});
  const owner = (await slackInstallationCredential(INSTALLATION_ID))?.owner;

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
