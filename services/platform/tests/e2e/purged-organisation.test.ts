import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { runInDurableObject } from "cloudflare:test";
import { expect, it, type TestContext } from "vitest";
import {
  requireActiveOrganisationActor,
  resolveActiveConnectorActor,
} from "../../src/actors/actor-router";
import { listOrganisationActorRegistryEntries } from "../../src/actors/actor-registry";
import type { ConnectorDO } from "../../src/actors/connector";
import { parseVaultHandle, storeVaultSecret } from "../../src/credential-vault";
import { newControlMutationIdentity } from "../../src/data/control-mutation";
import { createActiveConnectedIntegration } from "../../src/data/integration-account";
import { listOnboardingReconciliationOrganisationIds } from "../../src/data/onboarding-reconciliation";
import {
  archiveOrganisation,
  deleteArchivedOrganisation,
  type ArchiveOrganisationMutation,
} from "../../src/data/organisation-lifecycle";
import { registerWhatsAppPhoneNumberAccount } from "../../src/data/whatsapp";
import { parseConnectorId, parseUserId, type UserId } from "../../src/ids";
import { runScheduledOnboardingReconciliation } from "../../src/onboarding-reconciliation-runner";
import {
  parseE164PhoneNumber,
  parseMetaBusinessPortfolioId,
  parseWhatsAppBusinessAccountId,
  parseWhatsAppPhoneNumberId,
} from "../../src/whatsapp/identifiers";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import {
  ORGANISATION_ID,
  installSlackActorFixture,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    purgedOrganisation?: Record<string, unknown>;
  }
}

const PHONE_NUMBER_ID = "510000000000077";
const CUSTOMER_TEXT = "Is my order ready for collection?";
const REGISTRY_ROUTE = "https://localhost/v1/admin/state-object-registry";

it(
  "purges an Organisation whose Connector predates the rename once an operator empties it, and then leaves it out of the scheduled run",
  purgedOrganisationJourney,
  120_000,
);

async function purgedOrganisationJourney({ task }: TestContext) {
  await installSlackActorFixture();
  await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const userId = required(
    parseUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab"),
  );
  await fixtureDatabase()
    .prepare(
      "UPDATE service_role_grant SET role = 'owner' WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(ORGANISATION_ID, userId)
    .run();
  const connector = await installEarlierFormatConnector(userId);

  // An Organisation in use keeps its Connector.
  const refusedWhileLive = await eraseConnector(connector);
  expect(refusedWhileLive.status).toBe(409);
  expect(await refusedWhileLive.json()).toMatchObject({
    error: { code: "organisation_purge_not_due" },
  });
  expect(await storedIngress(connector.stub)).toBe(1);

  const scope = await requireOrganisationExecutionScope(env, ORGANISATION_ID);
  const archived = await archiveOrganisation({
    identityDatabase: env.DB,
    execution: scope,
    actorUserId: userId,
    authority: { kind: "organisation_owner" },
    reasonCode: "merchant_archived",
    now: Date.now(),
    mutation: await lifecycleMutation(userId, "archive"),
  });
  if (!archived.ok) throw new Error(archived.error.code);
  await runScheduledOnboardingReconciliation(env, Date.now());
  expect(await cleanupStatus()).toBe("pending_purge");

  // Archived, with its purge still a month away, it keeps its Connector too.
  const refusedBeforePurge = await eraseConnector(connector);
  expect(refusedBeforePurge.status).toBe(409);
  expect(await storedIngress(connector.stub)).toBe(1);

  const deleted = await deleteArchivedOrganisation({
    directory: env.DB,
    execution: await requireOrganisationExecutionScope(env, ORGANISATION_ID),
    actorUserId: userId,
    now: Date.now(),
    mutation: await lifecycleMutation(userId, "delete"),
  });
  if (!deleted.ok) throw new Error(deleted.error.code);

  // The purge reaches the Connector, cannot read it, and stops.
  const blockedAt = Date.now() + 1_000;
  await runScheduledOnboardingReconciliation(env, blockedAt);
  expect(await cleanupStatus()).toBe("pending_purge");
  expect(await archiveRuns()).toMatchObject({
    lifecycle: "failed",
    reasonCode: "reconciliation_subject_failed",
  });

  const erased = await eraseConnector(connector);
  expect(erased.status, await erased.clone().text()).toBe(200);
  expect(await erased.json()).toMatchObject({
    ok: true,
    report: {
      kind: "purged_connector_erased",
      registryId: connector.registryId,
    },
  });
  expect(await storedIngress(connector.stub)).toBe(0);
  expect(await connectorOwnerColumn(connector.stub)).toBe("organisation_id");

  const purgedAt = blockedAt + 15 * 60_000;
  await runScheduledOnboardingReconciliation(env, purgedAt);
  expect(await cleanupStatus()).toBe("purged");
  expect(await archiveRuns()).toMatchObject({ lifecycle: "completed" });
  expect(
    await fixtureDatabase()
      .prepare(
        "SELECT COUNT(*) AS count FROM whatsapp_phone_number_account WHERE organisation_id = ?",
      )
      .bind(ORGANISATION_ID)
      .first("count"),
  ).toBe(0);

  // Purged, it is no longer on the scheduled run's list, and a run adds nothing.
  const runsAtPurge = await reconciliationRunCount();
  expect(
    await listOnboardingReconciliationOrganisationIds(fixtureDatabase()),
  ).not.toContain(ORGANISATION_ID);
  await runScheduledOnboardingReconciliation(env, purgedAt + 15 * 60_000);
  expect(await reconciliationRunCount()).toBe(runsAtPurge);

  task.meta.purgedOrganisation = {
    organisation: ORGANISATION_ID,
    connector: connector.connectorId,
    eraseWhileLive: "refused: organisation_purge_not_due",
    eraseBeforePurgeIsDue: "refused: organisation_purge_not_due",
    purgeWithEarlierFormatConnector: "failed, cleanup stayed pending_purge",
    eraseOncePurgeIsDue: "erased, Connector tables recreated empty",
    purgeAfterErasure: "completed, cleanup purged",
    scheduledRunAfterPurge: `no run rows added (${runsAtPurge} before and after)`,
  };
}

type EarlierFormatConnector = {
  readonly stub: DurableObjectStub<ConnectorDO>;
  readonly connectorId: string;
  readonly registryId: string;
};

/**
 * A WhatsApp account whose Connector holds a customer message in storage
 * shaped as it was before the Organisation rename: the owner column is
 * `tenant_id`.
 */
async function installEarlierFormatConnector(
  userId: UserId,
): Promise<EarlierFormatConnector> {
  const now = Date.now();
  const handle = required(parseVaultHandle("vault:whatsapp:purged-journey"));
  required(
    await storeVaultSecret({
      db: fixtureDatabase(),
      keys: env,
      organisationId: ORGANISATION_ID,
      handle,
      secret: { kind: "bearer", value: "fixture-whatsapp-purged-token" },
      now,
    }),
  );
  const connected = await createActiveConnectedIntegration(fixtureDatabase(), {
    organisationId: ORGANISATION_ID,
    provider: "whatsapp",
    providerSubjectId: "410000000000077",
    environment: "development",
    authMode: "shared_satyr_app",
    authority: { kind: "connection_credential", credentialRef: handle },
    grantedScopes: ["whatsapp_business_messaging"],
    createdByUserId: userId,
    providerAccountId: PHONE_NUMBER_ID,
    accountKind: "phone_number",
    displayName: "Purged bakery",
    capabilities: ["whatsapp.support.ingress"],
    audiencePolicy: { kind: "customer", consentRequired: true },
    retentionPolicy: { kind: "organisation_default" },
    now,
  });
  const integrationAccountId = connected.account.integrationAccountId;
  required(
    await registerWhatsAppPhoneNumberAccount({
      db: fixtureDatabase(),
      organisationId: ORGANISATION_ID,
      integrationAccountId,
      providerConnectionId: connected.connection.providerConnectionId,
      environment: "development",
      businessPortfolioId: required(
        parseMetaBusinessPortfolioId("310000000000077"),
      ),
      wabaId: required(parseWhatsAppBusinessAccountId("410000000000077")),
      phoneNumberId: required(parseWhatsAppPhoneNumberId(PHONE_NUMBER_ID)),
      displayPhoneNumber: required(parseE164PhoneNumber("+819000000077")),
      verifiedName: "Purged bakery",
      now,
    }),
  );
  const connectorId = required(
    parseConnectorId(`connector_whatsapp_${integrationAccountId}`),
  );
  const stub = required(
    await resolveActiveConnectorActor({
      env,
      namespace: env.CONNECTOR,
      organisationId: ORGANISATION_ID,
      connectorId,
      now,
    }),
  );
  await runInDurableObject(stub, function storeEarlierFormat(_actor, state) {
    const sql = state.storage.sql;
    sql.exec(
      "INSERT OR REPLACE INTO connector_meta (singleton, organisation_id, connector_id) VALUES (1, ?, ?)",
      ORGANISATION_ID,
      connectorId,
    );
    sql.exec(
      "INSERT INTO connector_ingress (ingress_id, native_event_id, payload) VALUES ('ingress_purged', 'wamid.PURGED', ?)",
      JSON.stringify({ text: CUSTOMER_TEXT }),
    );
    sql.exec(
      "ALTER TABLE connector_meta RENAME COLUMN organisation_id TO tenant_id",
    );
  });
  const scope = await requireOrganisationExecutionScope(env, ORGANISATION_ID);
  const entries = required(
    await listOrganisationActorRegistryEntries({
      db: scope.database,
      organisationId: ORGANISATION_ID,
    }),
  );
  const entry = entries.find(function isJourneyConnector(candidate) {
    return (
      candidate.identity.objectKind === "connector" &&
      candidate.identity.logicalObjectId === connectorId
    );
  });
  if (entry === undefined) throw new Error("Connector registry entry missing");
  return { stub, connectorId, registryId: entry.registryId };
}

function eraseConnector(connector: EarlierFormatConnector): Promise<Response> {
  return exports.default.fetch(
    new Request(REGISTRY_ROUTE, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.ORGANISATION_ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command: "erase_purged_connector",
        organisationId: ORGANISATION_ID,
        connectorId: connector.connectorId,
        registryId: connector.registryId,
      }),
    }),
  );
}

function storedIngress(stub: DurableObjectStub<ConnectorDO>): Promise<number> {
  return runInDurableObject(stub, function countIngress(_actor, state) {
    return state.storage.sql
      .exec("SELECT COUNT(*) AS count FROM connector_ingress")
      .one().count as number;
  });
}

function connectorOwnerColumn(
  stub: DurableObjectStub<ConnectorDO>,
): Promise<string | null> {
  return runInDurableObject(stub, function readOwnerColumn(_actor, state) {
    const columns = state.storage.sql
      .exec("SELECT name FROM pragma_table_info('connector_meta')")
      .toArray()
      .map(function columnName(row) {
        return String(row.name);
      });
    return (
      columns.find(function isOwner(name) {
        return name === "organisation_id" || name === "tenant_id";
      }) ?? null
    );
  });
}

async function lifecycleMutation(
  userId: UserId,
  operation: "archive" | "delete",
): Promise<ArchiveOrganisationMutation> {
  const version = await fixtureDatabase()
    .prepare(
      "SELECT configuration_version FROM organisation_onboarding WHERE organisation_id = ?",
    )
    .bind(ORGANISATION_ID)
    .first<number>("configuration_version");
  if (version === null) throw new Error("Missing configuration version");
  return {
    boundary: {
      kind: "configuration_versioned",
      idempotencyKey: `purged-journey-${operation}`,
      requestHash: `purged-journey-${operation}-request`,
      expectedConfigurationVersion: version,
    },
    scope: {
      userId,
      organisationScope: ORGANISATION_ID,
      route: `/v1/control/organisations/${ORGANISATION_ID}${operation === "archive" ? "/archive" : ""}`,
      operation: `organisation.${operation}`,
    },
    identity: newControlMutationIdentity({
      portalSubjectHash: "purged-journey-owner",
      causationId: `purged-journey-${operation}`,
      now: Date.now(),
    }),
  };
}

function cleanupStatus(): Promise<unknown> {
  return fixtureDatabase()
    .prepare(
      "SELECT status FROM organisation_archive_cleanup WHERE organisation_id = ?",
    )
    .bind(ORGANISATION_ID)
    .first("status");
}

/** The latest run of the archive subject for the journey's Organisation. */
function archiveRuns(): Promise<unknown> {
  return fixtureDatabase()
    .prepare(
      `SELECT lifecycle, reason_code AS reasonCode FROM onboarding_reconciliation_run
     WHERE organisation_id = ? AND subject_kind = 'archived_organisation'
     ORDER BY started_at DESC LIMIT 1`,
    )
    .bind(ORGANISATION_ID)
    .first();
}

function reconciliationRunCount(): Promise<unknown> {
  return fixtureDatabase()
    .prepare(
      "SELECT COUNT(*) AS count FROM onboarding_reconciliation_run WHERE organisation_id = ?",
    )
    .bind(ORGANISATION_ID)
    .first("count");
}

function required<T>(
  result: { ok: true; value: T } | { ok: false; error: unknown },
): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
