import { runInDurableObject } from "cloudflare:test";
import { expect, it, type TestContext } from "vitest";

import type { ConnectorDO } from "../../src/actors/connector";
import { parseUserId } from "../../src/ids";
import { fixtureDatabase } from "./organisation-database";
import { erasedTableResidue, purgeOrganisation } from "./purge-support";
import { ORGANISATION_ID } from "./slack-journey-support";
import { installFixture, required } from "./whatsapp-connector-support";

declare module "vitest" {
  interface TaskMeta {
    whatsappErasure?: Record<string, unknown>;
  }
}

it(
  "empties the WhatsApp Connector of a purged Organisation before its rows go: no customer message, no reply draft, no open Case",
  whatsappErasureJourney,
  120_000,
);

async function whatsappErasureJourney({ task }: TestContext) {
  const fixture = await installFixture({
    customerText: "Can I collect the gift box at five?",
  });
  const userId = required(parseUserId(fixture.owner.session.userId));
  await fixtureDatabase()
    .prepare(
      "UPDATE service_role_grant SET role = 'owner' WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(ORGANISATION_ID, userId)
    .run();

  // Input: the number holds a customer's message and a reply draft in an
  // open Case, and the Organisation's tables name the number.
  const before = await connectorContent(fixture.connector);
  expect(before.customerMessages).toBeGreaterThan(0);
  expect(before.replyDrafts).toBe(1);
  expect(before.openCases).toBe(1);
  expect(await phoneNumberRows()).toBe(1);

  await purgeOrganisation({ organisationId: ORGANISATION_ID, userId });

  // The Connector is the only copy of the customer's text and the draft. The
  // purge empties it, and only then deletes the rows that name it.
  expect(await connectorContent(fixture.connector)).toEqual({
    customerMessages: 0,
    replyDrafts: 0,
    openCases: 0,
  });
  expect(await phoneNumberRows()).toBe(0);
  expect(await erasedTableResidue(ORGANISATION_ID)).toEqual({});

  task.meta.whatsappErasure = {
    organisation: ORGANISATION_ID,
    connector: fixture.identity.connectorId,
    before,
    after: { customerMessages: 0, replyDrafts: 0, openCases: 0 },
    phoneNumberRowsAfter: 0,
  };
}

type ConnectorContent = Readonly<{
  /** Encrypted customer messages that wait in the Connector. */
  customerMessages: number;
  /** Reply proposals that still hold an encrypted body. */
  replyDrafts: number;
  openCases: number;
}>;

function connectorContent(
  stub: DurableObjectStub<ConnectorDO>,
): Promise<ConnectorContent> {
  return runInDurableObject(stub, function countContent(_actor, state) {
    const sql = state.storage.sql;
    const count = (query: string) => sql.exec(query).one().count as number;
    return {
      customerMessages: count(
        "SELECT COUNT(*) AS count FROM connector_whatsapp_envelope",
      ),
      replyDrafts: count(
        "SELECT COUNT(*) AS count FROM connector_whatsapp_proposal WHERE ciphertext_b64 IS NOT NULL",
      ),
      openCases: count(
        "SELECT COUNT(*) AS count FROM connector_whatsapp_case WHERE closed_at IS NULL",
      ),
    };
  });
}

function phoneNumberRows(): Promise<unknown> {
  return fixtureDatabase()
    .prepare(
      "SELECT COUNT(*) AS count FROM whatsapp_phone_number_account WHERE organisation_id = ?",
    )
    .bind(ORGANISATION_ID)
    .first("count");
}
