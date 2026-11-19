import type { SingleDatabase } from "../src/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  admitSupplierPayoutEvent,
  listUnappliedEvents,
  type SupplierPayoutEvidence,
} from "../src/data/supplier-payout-event-inbox";
import { parseOrganisationId } from "../src/ids";
import { d1Database } from "./sqlite-d1";
import type { VariantBy } from "@purin-labs/type-utils";

const parsed = parseOrganisationId("organisation_inbox");
if (!parsed.ok) throw new Error("invalid organisation");
const ORGANISATION = parsed.value;
let database: DatabaseSync;
let db: SingleDatabase;
function event(): VariantBy<SupplierPayoutEvidence, "targetKind", "transfer"> {
  return {
    providerEventId: "event_1",
    rail: "gmo_aozora_private",
    integrationAccountId: "account_1",
    sourceReference: "source_1",
    environment: "development",
    targetKind: "transfer",
    targetId: "transfer_1",
    payloadDigest: "ab".repeat(32),
    amountMinor: 10000,
    currency: "JPY",
    observation: {
      kind: "provider_pending",
      providerTransferId: "transfer_1",
      providerState: "processing",
      observedAt: "2026-09-06T00:00:00Z",
    },
    occurredAt: Date.parse("2026-09-06T00:00:00Z"),
    receivedAt: Date.parse("2026-09-06T00:00:01Z"),
    evidenceRef: "protected/event_1",
  };
}
beforeEach(function seed() {
  database = new DatabaseSync(":memory:");
  database.exec(singleDatabaseSchema());
  db = d1Database(database);
  database
    .prepare(
      "INSERT INTO organisation (organisation_id, name, plan, created_at, status) VALUES (?, 'Inbox', 'beta', 1, 'active')",
    )
    .run(ORGANISATION);
});
afterEach(function close() {
  database.close();
});
describe("authenticated adapter evidence admission", function suite() {
  it("deduplicates by provider identity independently of arrival time", async function duplicate() {
    const original = event();
    expect(
      (
        await admitSupplierPayoutEvent({
          db,
          organisationId: ORGANISATION,
          event: original,
        })
      ).outcome,
    ).toBe("admitted");
    expect(
      (
        await admitSupplierPayoutEvent({
          db,
          organisationId: ORGANISATION,
          event: original,
        })
      ).outcome,
    ).toBe("duplicate");
    expect(
      (
        await admitSupplierPayoutEvent({
          db,
          organisationId: ORGANISATION,
          event: { ...original, receivedAt: original.receivedAt + 1 },
        })
      ).outcome,
    ).toBe("duplicate");
    expect(await listUnappliedEvents(db, ORGANISATION)).toHaveLength(1);
  });
  it("scopes event identities to integration and environment", async function scope() {
    await admitSupplierPayoutEvent({
      db,
      organisationId: ORGANISATION,
      event: event(),
    });
    await admitSupplierPayoutEvent({
      db,
      organisationId: ORGANISATION,
      event: { ...event(), integrationAccountId: "account_2" },
    });
    await admitSupplierPayoutEvent({
      db,
      organisationId: ORGANISATION,
      event: { ...event(), environment: "production" },
    });
    expect(await listUnappliedEvents(db, ORGANISATION)).toHaveLength(3);
    const other = parseOrganisationId("organisation_other");
    if (!other.ok) throw new Error("invalid organisation");
    expect(await listUnappliedEvents(db, other.value)).toEqual([]);
  });
  it("rejects observation identities and amounts that disagree at the boundary", async function invalid() {
    await expect(
      admitSupplierPayoutEvent({
        db,
        organisationId: ORGANISATION,
        event: { ...event(), targetId: "another_transfer" },
      }),
    ).rejects.toThrow();
    await expect(
      admitSupplierPayoutEvent({
        db,
        organisationId: ORGANISATION,
        event: { ...event(), amountMinor: 0 },
      }),
    ).rejects.toThrow();
    const forged = { ...event(), targetKind: "request" as const };
    await expect(
      admitSupplierPayoutEvent({
        db,
        organisationId: ORGANISATION,
        // @ts-expect-error A request identity cannot carry transfer-pending evidence.
        event: forged,
      }),
    ).rejects.toThrow("supplier_payout_request_evidence_invalid");
    expect(await listUnappliedEvents(db, ORGANISATION)).toEqual([]);
  });
});
