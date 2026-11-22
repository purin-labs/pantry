// The ports that the Worker registers (worker-ports.ts).
import "../src/worker-ports";
import type { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  createConnectedIntegration,
  finalizeConnectedIntegrationAccount,
} from "@purin-labs/connections/data/integration-account";
import { parseVaultHandle } from "../src/credential-vault";
import { parseOrganisationId } from "@purin-labs/kernel/ids";
import { parseUserId } from "@purin-labs/control-api/ids";
import {
  disableSlackOrganisationConnection,
  hasSlackOrganisationConnection,
  revokeDisabledSlackOrganisationConnection,
  revokeSlackOrganisationConnections,
} from "../src/slack/installation-store";
import { schemaDatabase } from "./split-topology";

const NOW = 1_791_470_000_000;

// The deployed topology: the Slack connection directory is in the global
// database and an Organisation's accounts are in its regional one. The other
// unit suites run on one database with both schemas, where a statement sent to the wrong
// database still finds its table.
it("finishes a Slack connection on the regional database and keeps its directory record in the global one", async function splitTopology() {
  const regional = schemaDatabase("migrations-regional");
  const global = schemaDatabase("migrations-global");
  const organisationId = parseOrganisationId("organisation_split");
  const userId = parseUserId("user_00000000-0000-4000-8000-000000000001");
  const credential = parseVaultHandle(
    "vault:organisation_split:slack:t1:oauth:1",
  );
  if (!organisationId.ok || !userId.ok || !credential.ok)
    throw new Error("ids");
  regional.sqlite.exec(
    `INSERT INTO organisation (organisation_id, name, created_at) VALUES ('${organisationId.value}', 'Split', ${NOW})`,
  );
  const connected = await createConnectedIntegration(regional.db, {
    organisationId: organisationId.value,
    provider: "slack",
    providerSubjectId: "T1",
    environment: "production",
    authMode: "shared_pantry_app",
    authority: {
      kind: "connection_credential",
      credentialRef: credential.value,
    },
    grantedScopes: ["chat:write"],
    createdByUserId: userId.value,
    providerAccountId: "T1",
    accountKind: "workspace",
    displayName: "Split workspace",
    capabilities: ["conversation.ingress", "conversation.egress"],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now: NOW,
  });
  const accountId = connected.account.integrationAccountId;

  const finalized = await finalizeConnectedIntegrationAccount({
    db: regional.db,
    organisationId: organisationId.value,
    integrationAccountId: accountId,
    now: NOW + 1,
  });
  expect(finalized).toMatchObject({
    ok: true,
    value: { lifecycle: { kind: "active" } },
  });

  global.sqlite.exec("PRAGMA foreign_keys = OFF");
  global.sqlite.exec(
    `INSERT INTO slack_organisation_connection (
       connection_id, installation_id, organisation_id, integration_account_id,
       lifecycle, revision, connected_at, updated_at, disabled_at, revoked_at
     ) VALUES ('slack_organisation_connection_split', 'slack_installation_split',
       '${organisationId.value}', '${accountId}', 'active', 1, ${NOW}, ${NOW}, NULL, NULL)`,
  );
  const target = {
    organisationId: organisationId.value,
    integrationAccountId: accountId,
  };
  expect(
    await hasSlackOrganisationConnection(
      global.db,
      organisationId.value,
      accountId,
    ),
  ).toBe(true);
  await disableSlackOrganisationConnection(global.db, {
    ...target,
    now: NOW + 2,
  });
  expect(connectionState(global.sqlite)).toEqual({
    lifecycle: "disabled",
    revision: 2,
  });
  await revokeDisabledSlackOrganisationConnection(global.db, {
    ...target,
    now: NOW + 3,
  });
  expect(connectionState(global.sqlite)).toEqual({
    lifecycle: "revoked",
    revision: 3,
  });
  expect(
    await revokeSlackOrganisationConnections(global.db, {
      organisationId: organisationId.value,
      now: NOW + 4,
    }),
  ).toBe(0);
});

function connectionState(sqlite: DatabaseSync): unknown {
  const row = sqlite
    .prepare("SELECT lifecycle, revision FROM slack_organisation_connection")
    .get();
  return row === undefined
    ? null
    : { lifecycle: row.lifecycle, revision: row.revision };
}
