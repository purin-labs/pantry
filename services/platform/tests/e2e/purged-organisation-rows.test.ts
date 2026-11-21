import { env } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";

import { publishOrganisationDirectoryRow } from "../../src/data/shared-rows/organisation-row";
import type { OrganisationId } from "../../src/ids";
import { runScheduledOnboardingReconciliation } from "../../src/onboarding-reconciliation-runner";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { network } from "./network";
import {
  seedSharedSlackWorkspace,
  slackAccount,
  slackAuthTestHandler,
  slackInstallationCredential,
  slackRecordsNaming,
  slackTokensCheckedByReadiness,
  type SharedSlackWorkspace,
} from "./slack-workspace-support";
import {
  archiveAsOwner,
  erasedTableResidue,
  purgeOwner,
  signInToChatGpt,
  type PurgeOwner,
} from "./purge-support";
import { stateObjectRegistryCommand } from "./state-object-registry-support";

declare module "vitest" {
  interface TaskMeta {
    purgedOrganisationRows?: Record<string, unknown>;
  }
}

const WORKSPACE: SharedSlackWorkspace = {
  key: "leftover",
  appId: "A12345678",
  teamId: "T0LEFTOVER",
  installationId: "installation_e2e_leftover",
  botToken: "xoxb-held-by-the-purged-vault",
  dmUser: "U0DMPERSON",
};

it(
  "erases what an earlier purge left of a purged Organisation, after the bot token of the Slack workspace that a live Organisation still uses moves to that Organisation",
  purgedOrganisationRowsJourney,
  180_000,
);

async function purgedOrganisationRowsJourney({ task }: TestContext) {
  const checkedTokens: string[] = [];
  network.use(slackAuthTestHandler(WORKSPACE.teamId, checkedTokens));

  // The first Organisation installed the workspace and signed in to ChatGPT.
  // A second Organisation uses the same workspace, with the bot token that
  // the first one's Vault holds.
  const purged = await purgeOwner("leftover-purged", "Leftover bakery");
  const neighbour = await purgeOwner("leftover-neighbour", "Neighbour cafe");
  await seedSharedSlackWorkspace(WORKSPACE, purged, neighbour);
  await signInToChatGpt(purged);
  expect(await slackTokensCheckedByReadiness(neighbour, checkedTokens)).toEqual(
    [WORKSPACE.botToken],
  );

  await purgeBeforeTheCatalogue(purged);
  const left = await erasedTableResidue(purged.organisationId);
  expect(left).toMatchObject({
    access_grant: expect.any(Number),
    organisation_capability_policy: expect.any(Number),
    organisation_codex_connection: 1,
    vault_secret: 2,
  });
  // The scheduled cleanup ended the person's DM choice; the thread pin stays.
  expect(await slackRecordsNaming(purged.organisationId)).toEqual({
    installationsOwned: 1,
    dmSelections: 0,
    threadPins: 1,
  });

  // The scheduled run leaves a purged Organisation alone, so it never erases
  // these rows.
  await runScheduledOnboardingReconciliation(env, Date.now() + 900_000);
  expect(await erasedTableResidue(purged.organisationId)).toEqual(left);

  // An Organisation in use is refused and keeps its rows and its workspace.
  const refused = await eraseRows(neighbour.organisationId);
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({
    error: { code: "organisation_not_purged" },
  });
  expect(await slackInstallationCredential(WORKSPACE.installationId)).toEqual(
    expect.objectContaining({ owner: purged.organisationId }),
  );

  const erased = await eraseRows(purged.organisationId);
  expect(erased.status, await erased.clone().text()).toBe(200);
  const report: unknown = await erased.json();
  expect(report).toMatchObject({
    ok: true,
    report: {
      kind: "purged_organisation_rows_erased",
      slackInstallationsReleased: 1,
      erasedRows: { ...left, slack_thread_case_pin: 1 },
    },
  });

  // Nothing that the purge erases names the purged Organisation any more, its
  // Vault included, and the Organisation that uses the workspace now holds
  // the token. Its Slack still checks out with the same token.
  expect(await erasedTableResidue(purged.organisationId)).toEqual({});
  expect(await slackRecordsNaming(purged.organisationId)).toEqual({
    installationsOwned: 0,
    dmSelections: 0,
    threadPins: 0,
  });
  const moved = await slackInstallationCredential(WORKSPACE.installationId);
  expect(moved).toMatchObject({
    owner: neighbour.organisationId,
    lifecycle: "active",
  });
  expect(await slackTokensCheckedByReadiness(neighbour, checkedTokens)).toEqual(
    [WORKSPACE.botToken],
  );
  expect(await slackAccount(neighbour)).toMatchObject({
    lifecycle: { kind: "active" },
    credential_health: { kind: "healthy" },
  });

  // A second run finds nothing left and changes nothing.
  const repeated = await eraseRows(purged.organisationId);
  expect(repeated.status, await repeated.clone().text()).toBe(200);
  expect(await repeated.json()).toMatchObject({
    report: { slackInstallationsReleased: 0, erasedRows: {} },
  });
  expect(await slackInstallationCredential(WORKSPACE.installationId)).toEqual(
    moved,
  );

  task.meta.purgedOrganisationRows = {
    purgedOrganisation: purged.organisationId,
    tablesLeftByTheEarlierPurge: left,
    refusedForALiveOrganisation: "organisation_not_purged",
    report,
    neighbourSlackAfterErase: "healthy with the moved token",
    installationOwner:
      moved?.owner === neighbour.organisationId
        ? "neighbour"
        : String(moved?.owner),
    secondRun: "nothing erased, installation unchanged",
  };
}

/**
 * What a purge before the catalogue (Refactor 15) left: the owner archived
 * the Organisation, the scheduled cleanup revoked its credentials, and the
 * purge marked it purged without the catalogue, so its other rows and its
 * Vault stay. That purge code is gone, so the journey writes its last step.
 */
async function purgeBeforeTheCatalogue(owner: PurgeOwner): Promise<void> {
  await archiveAsOwner(owner);
  await runScheduledOnboardingReconciliation(env, Date.now());
  const scope = await requireOrganisationExecutionScope(
    env,
    owner.organisationId,
  );
  await scope.database.batch(
    [
      "UPDATE organisation_onboarding SET lifecycle = 'purged' WHERE organisation_id = ?",
      "UPDATE organisation_archive_cleanup SET status = 'purged' WHERE organisation_id = ?",
      `UPDATE organisation
       SET name = 'Archived organisation', organisation_handle = NULL, status = 'purged'
       WHERE organisation_id = ?`,
    ].map((sql) => scope.database.prepare(sql).bind(owner.organisationId)),
  );
  await publishOrganisationDirectoryRow({
    directory: env.DB,
    db: scope.database,
    organisationId: owner.organisationId,
  });
}

function eraseRows(organisationId: OrganisationId): Promise<Response> {
  return stateObjectRegistryCommand({
    command: "erase_purged_organisation_rows",
    organisationId,
  });
}
