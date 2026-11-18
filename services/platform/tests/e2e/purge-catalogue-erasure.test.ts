import { env } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";

import { parseVaultHandle, storeVaultSecret } from "../../src/credential-vault";
import {
  createCustomConnectorDraft,
  prepareCustomConnectorDraftDocument,
} from "../../src/custom-connectors/revisions";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import {
  erasedTableResidue,
  purgeOrganisation,
  purgeOwner,
  type PurgeOwner,
} from "./purge-support";

declare module "vitest" {
  interface TaskMeta {
    purgeCatalogueErasure?: Record<string, unknown>;
  }
}

it(
  "leaves no row of a purged Organisation in a table that the purge catalogue marks erase, and frees its handle",
  purgeCatalogueErasureJourney,
  120_000,
);

async function purgeCatalogueErasureJourney({ task }: TestContext) {
  const owner = await purgeOwner("purge-catalogue-owner", "Catalogue bakery");
  await connectChatGpt(owner);
  await draftCustomConnector(owner);
  const handle = await directoryHandle(owner);
  expect(handle).not.toBeNull();
  // The Organisation in use holds rows in tables that the purge erases.
  const before = await erasedTableResidue(owner.organisationId);
  expect(before).toMatchObject({
    organisation_codex_connection: 1,
    custom_connector: 1,
    custom_connector_revision: 1,
  });

  await purgeOrganisation(owner);

  expect(await erasedTableResidue(owner.organisationId)).toEqual({});
  const scope = await requireOrganisationExecutionScope(
    env,
    owner.organisationId,
  );
  const row = await scope.database
    .prepare(
      `SELECT organisation.status AS status, organisation.organisation_handle AS handle,
              onboarding.lifecycle AS lifecycle
       FROM organisation
       JOIN organisation_onboarding AS onboarding
         ON onboarding.organisation_id = organisation.organisation_id
       WHERE organisation.organisation_id = ?`,
    )
    .bind(owner.organisationId)
    .first();
  expect(row).toEqual({ status: "purged", handle: null, lifecycle: "purged" });
  expect(await directoryHandle(owner)).toBeNull();

  task.meta.purgeCatalogueErasure = {
    organisation: owner.organisationId,
    erasedTablesWithRowsBefore: Object.keys(before).length,
    erasedTablesWithRowsAfter: 0,
    regionalRow: row,
    directoryHandleAfter: null,
  };
}

/** Input: the ChatGPT sign-in that the Organisation's owner finished. */
async function connectChatGpt(owner: PurgeOwner): Promise<void> {
  const now = Date.now();
  const scope = await requireOrganisationExecutionScope(
    env,
    owner.organisationId,
  );
  const handle = parseVaultHandle(
    `vault:${owner.organisationId.toLowerCase()}:codex:profile:1`,
  );
  if (!handle.ok) throw new Error("The ChatGPT profile handle is invalid");
  const stored = await storeVaultSecret({
    db: scope.database,
    keys: env,
    organisationId: owner.organisationId,
    handle: handle.value,
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
    .bind(owner.organisationId, handle.value, now, now, now, now)
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

function directoryHandle(owner: PurgeOwner): Promise<unknown> {
  return env.DB.prepare(
    "SELECT organisation_handle FROM organisation WHERE organisation_id = ?",
  )
    .bind(owner.organisationId)
    .first("organisation_handle");
}
